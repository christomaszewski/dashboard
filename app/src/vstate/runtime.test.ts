import { describe, expect, it, vi } from "vitest";
import { loadRuntimeKeys, loadStateKey, RUNTIME_URL } from "./runtime";

const BASE = "fleet/vehicle1/dash/main/state";
const response = (doc: unknown) => vi.fn(async () => ({ ok: true, json: async () => doc })) as unknown as typeof fetch;

describe("dashboard runtime keys", () => {
  it("loads the optional run-only state key independently of full vehicle state", async () => {
    const fetcher = response({ current_run_state_key: BASE });
    expect(await loadRuntimeKeys(fetcher)).toMatchObject({ currentRunBase: BASE, base: undefined });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(RUNTIME_URL, { cache: "no-store" });
  });

  it("uses the same backend for the shared view and leaves missing run metadata disabled", async () => {
    expect(await loadRuntimeKeys(response({ vehicle_state_key: BASE, current_run_state_key: BASE }))).toMatchObject({ base: BASE, currentRunBase: BASE });
    expect((await loadRuntimeKeys(response({ vehicle_state_key: BASE }))).currentRunBase).toBeUndefined();
    expect(await loadStateKey(response({ vehicle_state_key: BASE }))).toEqual({ base: BASE });
  });

  it("accepts runtime keys for dotted vehicle identities", async () => {
    const base = "fleet/rover.3/dash/main/state";
    expect(await loadRuntimeKeys(response({ vehicle_state_key: base, current_run_state_key: base }))).toMatchObject({
      base, currentRunBase: base, error: undefined, currentRunError: undefined,
    });
  });

  it("validates both keys and keeps a full-state override independent of the local run registry", async () => {
    const invalid = await loadRuntimeKeys(response({ vehicle_state_key: "fleet/*/state", current_run_state_key: "fleet/*/state" }));
    expect(invalid.error).toContain("vehicle_state_key");
    expect(invalid.currentRunError).toContain("current_run_state_key");
    expect(invalid.base).toBeUndefined();
    expect(invalid.currentRunBase).toBeUndefined();
    expect(await loadRuntimeKeys(response({ current_run_state_key: BASE }), "fleet/other/dash/main/state")).toMatchObject({
      base: "fleet/other/dash/main/state", currentRunBase: BASE, error: undefined,
    });
  });

  it("does not keep retrying a missing optional runtime file, but retries network failures", async () => {
    const missing = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    expect(await loadRuntimeKeys(missing)).toMatchObject({ retry: false });
    const broken = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await loadRuntimeKeys(broken)).toMatchObject({ retry: true, error: expect.stringContaining("network down") });
  });
});
