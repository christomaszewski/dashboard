import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RigDiscovery } from "./discovery";
import type { RigAgent, RigJob } from "./types";
import type { LivelinessEvent, Sample, Transport } from "../transport/types";

const KEY = "fleet/1/rig";
const DESCRIPTOR = { schema_version: 1, service: "rig-agent", vehicle_id: "1", vehicle: "orin-dev", poll_s: 10, capabilities: { actuate: true } };
const STATE = { schema_version: 1, vehicle_id: "1", vehicle: "orin-dev", at_unix_s: 1000, ok: true, error: null, run: null, registry: { data_dir: null, free_kb: null, problem: null }, stacks: [{ name: "cam_front", state: "running" }], job: null };
const JOB = (id: string, state: string, submitted: number) => ({ job_id: id, verb: "up", args: {}, argv: ["up"], client: null, self_terminating: false, state, submitted_unix_s: submitted, started_unix_s: null, ended_unix_s: null, deadline_unix_s: null, timeout_s: 600, exit_code: null, error: null, error_kind: null, guard_projects: [], log_tail: [], result: {} });
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

function stubTransport(replies: Record<string, unknown> = {}) {
  let onToken: ((e: LivelinessEvent) => void) | null = null;
  const subs = new Map<string, (s: Sample) => void>();
  const gets: string[] = [];
  const table: Record<string, unknown> = { [KEY]: DESCRIPTOR, [`${KEY}/state`]: STATE, [`${KEY}/jobs`]: { ok: true, jobs: [JOB("j-1", "succeeded", 900)] }, ...replies };
  const transport = {
    subscribe: async (pattern: string, onSample: (s: Sample) => void) => {
      subs.set(pattern, onSample);
      return { close: async () => undefined };
    },
    get: async (keyexpr: string) => {
      gets.push(keyexpr);
      const v = table[keyexpr];
      return v === undefined ? [] : [{ keyexpr, payload: enc(v) }];
    },
    liveliness: {
      subscribe: async (_pattern: string, onEvent: (e: LivelinessEvent) => void) => {
        onToken = onEvent;
        return { close: async () => undefined };
      },
      get: async () => [],
    },
    close: async () => undefined,
  } as unknown as Transport;
  return {
    transport,
    gets,
    token: (e: LivelinessEvent) => onToken?.(e),
    publish: (keyexpr: string, payload: unknown) => {
      for (const [pattern, cb] of subs) {
        const re = new RegExp("^" + pattern.replace(/\*/g, "[^/]+") + "$");
        if (re.test(keyexpr)) cb({ keyexpr, payload: enc(payload), kind: "put" });
      }
    },
  };
}

describe("RigDiscovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function start(replies?: Record<string, unknown>, graceMs = 15_000) {
    const stub = stubTransport(replies);
    const discovery = new RigDiscovery(stub.transport, graceMs);
    let agents: RigAgent[] = [];
    let jobs: RigJob[] = [];
    await discovery.start((a, j) => {
      agents = a;
      jobs = j;
    });
    return { ...stub, discovery, agents: () => agents, jobs: () => jobs };
  }

  it("token PUT → descriptor, state and jobs gets → one agent with state and history", async () => {
    const { token, gets, agents, jobs } = await start();
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    expect(gets).toEqual([KEY, `${KEY}/state`, `${KEY}/jobs`]);
    expect(agents()).toHaveLength(1);
    expect(agents()[0]).toMatchObject({ key: KEY, vehicleId: "1", alive: true, descriptor: { vehicle: "orin-dev" } });
    expect(agents()[0].state?.stacks[0].name).toBe("cam_front");
    expect(jobs().map((j) => j.job_id)).toEqual(["j-1"]);
  });

  it("state and job publications update without new gets; jobs sort newest first and cap", async () => {
    const { token, publish, gets, agents, jobs } = await start();
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    publish(`${KEY}/state`, { ...STATE, at_unix_s: 1010, stacks: [{ name: "cam_front", state: "down" }] });
    expect(gets).toHaveLength(3);
    expect(agents()[0].state?.stacks[0].state).toBe("down");
    expect(agents()[0].state?.at_unix_s).toBe(1010);
    publish(`${KEY}/jobs/events`, JOB("j-2", "queued", 1000));
    publish(`${KEY}/jobs/events`, JOB("j-2", "running", 1000));
    expect(jobs().map((j) => [j.job_id, j.state])).toEqual([["j-2", "running"], ["j-1", "succeeded"]]);
    for (let i = 0; i < 80; i++) publish(`${KEY}/jobs/events`, JOB(`j-b${i}`, "succeeded", 2000 + i));
    expect(jobs()).toHaveLength(50);
    expect(jobs()[0].job_id).toBe("j-b79");
  });

  it("a state publication for an unseen key stands the agent up and fetches its descriptor", async () => {
    const { publish, gets, agents } = await start();
    publish(`${KEY}/state`, STATE);
    expect(agents()).toHaveLength(1);
    expect(agents()[0].state?.vehicle).toBe("orin-dev");
    await vi.runAllTimersAsync();
    expect(gets).toEqual([KEY]);
    expect(agents()[0].descriptor.poll_s).toBe(10);
  });

  it("ignores foreign keys, malformed payloads and a vehicle_id that contradicts the key", async () => {
    const { token, publish, agents, jobs } = await start({ "fleet/2/rig": { ...DESCRIPTOR, vehicle_id: "9" } });
    token({ keyexpr: "fleet/1/svc/cam0/lifecycle", alive: true });
    token({ keyexpr: "fleet/2/rig", alive: true });
    publish(`${KEY}/state`, { hello: "world" });
    publish(`${KEY}/state`, { ...STATE, vehicle_id: "7" });
    publish(`${KEY}/jobs/events`, { nope: true });
    await vi.runAllTimersAsync();
    expect(agents()).toHaveLength(0);
    expect(jobs()).toHaveLength(0);
  });

  it("token DELETE → offline, removed after the grace; a re-PUT inside it revives with state kept", async () => {
    const { token, agents } = await start();
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    token({ keyexpr: KEY, alive: false });
    expect(agents()[0].alive).toBe(false);
    expect(agents()[0].state).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_000);
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    expect(agents()[0].alive).toBe(true);
    token({ keyexpr: KEY, alive: false });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(agents()).toHaveLength(0);
  });

  it("refresh re-reads state and jobs for every agent", async () => {
    const { token, gets, discovery } = await start();
    token({ keyexpr: KEY, alive: true });
    await vi.runAllTimersAsync();
    await discovery.refresh();
    expect(gets.slice(3)).toEqual([`${KEY}/state`, `${KEY}/jobs`]);
  });
});
