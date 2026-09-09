// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunClouds } from "./RunClouds";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Caddy's JSON `browse` listing, keyed by URL; anything else is a 404 (no mount). */
function serve(table: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const body = table[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}
const dir = (name: string) => ({ name, size: 0, is_dir: true });
const file = (name: string, size = 10) => ({ name, size, is_dir: false });
const registry = {
  "/rig-data/runs/": [dir("20260904T194932Z_auto"), dir("20260909T042758Z_replay"), file("stray.txt")],
  "/rig-data/runs/20260909T042758Z_replay/": [dir("recordings"), dir("clouds"), file("manifest.yaml", 512)],
  "/rig-data/runs/20260909T042758Z_replay/clouds/": [file("scan.las", 3_000_000), file("notes.txt"), file("tile.bpf", 1500)],
  "/rig-data/runs/20260909T042758Z_replay/recordings/": [],
};

describe("RunClouds", () => {
  it("lists the runs newest first, walks a run lazily, and opens a cloud file by its /rig-data URL", async () => {
    serve(registry);
    const onOpen = vi.fn();
    render(<RunClouds onOpen={onOpen} quiet />);
    await waitFor(() => expect(screen.getByText("Rig runs:")).toBeTruthy());
    const runButtons = [...document.querySelectorAll("li.rig-tree-dir > button")].map((b) => b.textContent);
    expect(runButtons).toEqual(["▸ 20260909T042758Z_replay/", "▸ 20260904T194932Z_auto/"]); // newest first; the stray file is not a run
    fireEvent.click(screen.getByText("▸ 20260909T042758Z_replay/"));
    await waitFor(() => expect(screen.getByText("▸ clouds/")).toBeTruthy());
    expect(screen.queryByText(/manifest\.yaml/)).toBeNull(); // not a cloud: not listed by name
    expect(screen.getByText("1 other file")).toBeTruthy();
    fireEvent.click(screen.getByText("▸ clouds/"));
    await waitFor(() => expect(screen.getByText("scan.las")).toBeTruthy());
    expect(screen.getByText("tile.bpf")).toBeTruthy();
    expect(screen.queryByText("notes.txt")).toBeNull();
    fireEvent.click(screen.getByText("scan.las"));
    expect(onOpen).toHaveBeenCalledWith("/rig-data/runs/20260909T042758Z_replay/clouds/scan.las", "scan.las");
    fireEvent.click(screen.getByText("▸ recordings/"));
    await waitFor(() => expect(screen.getByText("empty")).toBeTruthy());
  });

  it("renders nothing in quiet mode when the registry is not served, and says so otherwise", async () => {
    serve({});
    const { container } = render(<RunClouds onOpen={vi.fn()} quiet />);
    await waitFor(() => expect(container.textContent).toBe(""));
    cleanup();
    render(<RunClouds onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/run registry not served/)).toBeTruthy());
    cleanup();
    serve({ "/rig-data/runs/": [] });
    render(<RunClouds onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/no runs in the registry yet/)).toBeTruthy());
  });
});
