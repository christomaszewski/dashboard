import { describe, expect, it } from "vitest";
import { dirUrl, fileUrl, listDir, loadSidecar, parseSidecar, probeRigData, type FetchFn } from "./runsData";

function fetchStub(table: Record<string, unknown>, opts: { contentType?: string } = {}): { fetchFn: FetchFn; urls: string[] } {
  const urls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    urls.push(url);
    const body = table[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": opts.contentType ?? "application/json" } });
  };
  return { fetchFn, urls };
}

describe("run data urls", () => {
  it("encodes each segment", () => {
    expect(dirUrl([])).toBe("/rig-data/");
    expect(dirUrl(["runs", "20260902T140000Z_flight1", "recordings"])).toBe("/rig-data/runs/20260902T140000Z_flight1/recordings/");
    expect(fileUrl(["runs", "x", "a b#1.mkv"])).toBe("/rig-data/runs/x/a%20b%231.mkv");
  });
});

describe("listDir / probe", () => {
  it("parses Caddy's JSON listing, dirs first, and hides absent mounts", async () => {
    const { fetchFn, urls } = fetchStub({
      "/rig-data/runs/r1/": [
        { name: "cam.mkv", size: 5, is_dir: false, mod_time: "2026-09-02T14:00:00Z" },
        { name: "recordings", size: 0, is_dir: true },
        { name: ".rig", size: 0, is_dir: true },
        { bogus: 1 },
      ],
    });
    expect(await listDir(["runs", "r1"], fetchFn)).toEqual([
      { name: ".rig", size: 0, isDir: true, modTime: undefined },
      { name: "recordings", size: 0, isDir: true, modTime: undefined },
      { name: "cam.mkv", size: 5, isDir: false, modTime: "2026-09-02T14:00:00Z" },
    ]);
    expect(urls[0]).toBe("/rig-data/runs/r1/");
    expect(await listDir(["missing"], fetchFn)).toBeNull();
    expect(await probeRigData(fetchFn)).toBe(false);
    expect(await probeRigData(fetchStub({ "/rig-data/": [] }).fetchFn)).toBe(true);
    expect(await listDir([], fetchStub({ "/rig-data/": [] }, { contentType: "text/html" }).fetchFn)).toBeNull();
  });
});

describe("sidecars", () => {
  it("reads camera-service's session block + drops, or a flat shape; rejects non-sidecars", () => {
    expect(parseSidecar({ drops: { frames_missing: 2, other: "x" }, session: { frames_recorded: 500, segments: 3, truncated: true, error: null } })).toEqual({
      frames: 500,
      segments: 3,
      truncated: true,
      drops: { frames_missing: 2 },
    });
    expect(parseSidecar({ frames: 10, files: ["a", "b"], error: "late" })).toEqual({ frames: 10, segments: 2, error: "late" });
    expect(parseSidecar({ unrelated: true })).toBeNull();
    expect(parseSidecar("nope")).toBeNull();
  });

  it("loads one over http", async () => {
    const { fetchFn } = fetchStub({ "/rig-data/runs/r1/recordings/cam0/cam.json": { session: { frames_recorded: 7 } } });
    expect(await loadSidecar(["runs", "r1", "recordings", "cam0", "cam.json"], fetchFn)).toEqual({ frames: 7 });
    expect(await loadSidecar(["runs", "r1", "recordings", "cam0", "nope.json"], fetchFn)).toBeNull();
  });
});
