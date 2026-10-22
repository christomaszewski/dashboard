import { describe, expect, it, vi } from "vitest";
import type { Transport } from "../transport/types";
import { containerLabel, listContainers, plainLog, readLogs } from "./client";

const id = "a".repeat(64);
const base = "fleet/1/rig";
const container = { id, name: "cam-1", image: "camera:local", state: "running", status: "Up", project: "cam", service: "camera" };
function fake(doc: unknown) {
  const get = vi.fn().mockResolvedValue([{ keyexpr: base, payload: new TextEncoder().encode(JSON.stringify(doc)) }]);
  return { get, transport: { get } as unknown as Transport };
}

describe("Docker log client", () => {
  it("lists containers with Compose labels and sends a bounded log request to the selected vehicle", async () => {
    const f = fake({ schema_version: 1, ok: true, containers: [container] });
    expect(await listContainers(f.transport, base)).toEqual([container]);
    expect(containerLabel(container)).toBe("cam / camera — cam-1 (running)");
    const snapshot = { schema_version: 1, ok: true, container_id: id, tail: 200, text: "hello", truncated: false, at_unix_s: 1 };
    const g = fake(snapshot);
    expect(await readLogs(g.transport, base, id, 200)).toEqual(snapshot);
    const [key, options] = g.get.mock.calls[0];
    expect(key).toBe(`${base}/docker/logs`);
    expect(JSON.parse(new TextDecoder().decode(options.payload))).toEqual({ container_id: id, tail: 200 });
    expect(options).toMatchObject({ timeoutMs: 5000, maxReplies: 1, maxReplyBytes: 1024 * 1024 });
  });

  it("surfaces Docker refusals and rejects malformed or mismatched replies", async () => {
    await expect(readLogs(fake({ ok: false, error: "No such container" }).transport, base, id, 200)).rejects.toThrow("No such container");
    await expect(listContainers(fake({ schema_version: 1, ok: true, containers: [{}] }).transport, base)).rejects.toThrow("Invalid Docker container inventory");
    const snap = { schema_version: 1, ok: true, container_id: id, tail: 200, text: "", truncated: false, at_unix_s: 1 };
    for (const override of [{ container_id: "b".repeat(64) }, { tail: 500 }, { text: "x".repeat(65537) }]) {
      await expect(readLogs(fake({ ...snap, ...override }).transport, base, id, 200)).rejects.toThrow("Invalid Docker log snapshot");
    }
    const f = fake({});
    f.get.mockResolvedValue([]);
    await expect(listContainers(f.transport, base)).rejects.toThrow("No reply");
  });

  it("removes ANSI colors, terminal hyperlinks, and control bytes while preserving lines and text", () => {
    expect(plainLog("\x1b[31merror\x1b[0m\n\x1b]8;;https://example.com\x07link\x1b]8;;\x07\t<script>\x00"))
      .toBe("error\nlink\t<script>");
  });
});
