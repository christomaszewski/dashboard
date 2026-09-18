import { describe, expect, it } from "vitest";
import { rowActions, rowPill } from "./actions";
import type { RigStackRow } from "./types";
import type { LifecycleService } from "../lifecycle/types";

const row = (over: Partial<RigStackRow> = {}): RigStackRow => ({
  name: "cam_front", service: "camera-service", tier: "sensor", order: 30, enabled: true, project: "cam_front-vehicle-1",
  state: "running", health: "healthy", op_state: null, running: 2, total: 2, state_verbs: false, self: false, ...over,
});
const OPTS = { actuate: true, busy: false, agentAlive: true };
const lifecycle = (state: string, transitions: string[], alive = true): LifecycleService => ({
  key: "fleet/1/svc/cam_front/lifecycle", vehicleId: "1", instance: "cam_front", alive,
  descriptor: { schema_version: 1, service: "camera-service", instance: "cam_front", state, transitions },
});
const verbs = (actions: ReturnType<typeof rowActions>) => actions.map((a) => (a.kind === "lifecycle" ? `lc:${a.transition}` : `${a.verb}${a.disabled ? "!" : ""}`));

describe("rowActions", () => {
  it("prefers the lifecycle transitions when the instance advertises one; compose verbs stay", () => {
    expect(verbs(rowActions(row(), lifecycle("inactive", ["activate"]), OPTS))).toEqual(["lc:activate", "down"]);
    expect(verbs(rowActions(row({ state_verbs: true, op_state: "active" }), lifecycle("active", ["deactivate"]), OPTS))).toEqual(["lc:deactivate", "down"]);
  });

  it("falls back to rig's trio per op_state, then up/down per compose state", () => {
    expect(verbs(rowActions(row({ state_verbs: true, op_state: "active" }), undefined, OPTS))).toEqual(["standby", "down"]);
    expect(verbs(rowActions(row({ state_verbs: true, op_state: "standby" }), undefined, OPTS))).toEqual(["activate", "down"]);
    expect(verbs(rowActions(row({ state_verbs: true, op_state: "unknown" }), undefined, OPTS))).toEqual(["standby", "activate", "down"]);
    expect(verbs(rowActions(row({ state_verbs: true, op_state: "transitioning" }), undefined, OPTS))).toEqual(["down"]);
    expect(verbs(rowActions(row({ state_verbs: true, op_state: "down", state: "down", running: 0 }), undefined, OPTS))).toEqual(["up"]);
    expect(verbs(rowActions(row({ state: "partial", running: 1 }), undefined, OPTS))).toEqual(["up", "down"]);
    expect(verbs(rowActions(row(), undefined, OPTS))).toEqual(["down"]);
  });

  it("disabled rows get nothing; self row cannot be downed; primaries are marked", () => {
    expect(rowActions(row({ enabled: false, state: "down" }), undefined, OPTS)).toEqual([]);
    const self = rowActions(row({ name: "dashboard", self: true }), undefined, OPTS);
    expect(self).toHaveLength(1);
    expect(self[0]).toMatchObject({ kind: "rig", verb: "down", disabled: expect.stringContaining("hosts the dashboard") });
    const up = rowActions(row({ state: "down", running: 0 }), undefined, OPTS);
    expect(up[0]).toMatchObject({ verb: "up", primary: true });
    const lc = rowActions(row(), lifecycle("inactive", ["activate", "shutdown"]), OPTS);
    expect(lc[0]).toMatchObject({ kind: "lifecycle", transition: "activate", primary: true });
    expect(lc[1]).toMatchObject({ kind: "lifecycle", transition: "shutdown", primary: false });
  });

  it("actuate off / busy / agent offline disable every rig action with a reason, never lifecycle ones", () => {
    for (const [opts, reason] of [
      [{ ...OPTS, actuate: false }, "actuation disabled"],
      [{ ...OPTS, busy: true }, "already running"],
      [{ ...OPTS, agentAlive: false }, "offline"],
    ] as const) {
      const actions = rowActions(row({ state_verbs: true, op_state: "active" }), undefined, opts);
      expect(actions.every((a) => a.kind === "rig" && a.disabled?.includes(reason))).toBe(true);
      const withLc = rowActions(row(), lifecycle("active", ["deactivate"]), opts);
      expect(withLc[0]).toMatchObject({ kind: "lifecycle" });
    }
  });
});

describe("rowPill", () => {
  it("lifecycle state wins, then op_state, then the compose roll-up", () => {
    expect(rowPill(row(), lifecycle("active", ["deactivate"]))).toMatchObject({ text: "active", level: "ok" });
    expect(rowPill(row(), lifecycle("inactive", ["activate"], false))).toMatchObject({ text: "inactive · offline", level: "warn" });
    expect(rowPill(row({ state_verbs: true, op_state: "standby" }), undefined)).toMatchObject({ text: "standby", level: "idle" });
    expect(rowPill(row({ state_verbs: true, op_state: "standby", state: "down" }), undefined)).toMatchObject({ text: "down", level: "idle" });
    expect(rowPill(row({ health: "unhealthy" }), undefined)).toMatchObject({ text: "running", level: "err" });
    expect(rowPill(row({ enabled: false }), undefined)).toMatchObject({ text: "disabled", level: "idle" });
  });
});
