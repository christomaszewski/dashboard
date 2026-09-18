import { describe, expect, it } from "vitest";
import { CONFIG_URL, loadDashboardConfig } from "./load";

function fetchStub(fn: (url: string) => Promise<Response>): typeof fetch {
  return ((url: string) => fn(url)) as unknown as typeof fetch;
}

describe("loadDashboardConfig", () => {
  it("200 + YAML → ready with parsed config", async () => {
    const state = await loadDashboardConfig(
      fetchStub(async (url) => {
        expect(url).toBe(CONFIG_URL);
        return new Response("name: d\nws_port: 10001\nhome:\n  widgets: []\n", { status: 200 });
      }),
    );
    expect(state).toMatchObject({ phase: "ready", config: { name: "d", ws_port: 10001 } });
  });

  it("404 → absent (built-in defaults)", async () => {
    const state = await loadDashboardConfig(fetchStub(async () => new Response("not found", { status: 404 })));
    expect(state).toEqual({ phase: "absent" });
  });

  it("network failure → absent", async () => {
    const state = await loadDashboardConfig(fetchStub(async () => Promise.reject(new Error("offline"))));
    expect(state).toEqual({ phase: "absent" });
  });

  it("unparseable YAML → error with position info", async () => {
    const state = await loadDashboardConfig(fetchStub(async () => new Response("a: [unclosed", { status: 200 })));
    expect(state.phase).toBe("error");
    if (state.phase === "error") expect(state.message).toMatch(/unparseable/);
  });
});
