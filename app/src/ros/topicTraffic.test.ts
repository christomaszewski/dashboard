import { describe, expect, it } from "vitest";
import { encodeAttachment } from "../services/attachment";
import { TopicTraffic } from "./topicTraffic";
import type { Sample } from "../transport/types";

function sample(size: number, publisher?: number, layout: "plain" | "labelled" = "plain"): Sample {
  return { keyexpr: "topic", kind: "put", payload: new Uint8Array(size), attachment: publisher === undefined ? undefined :
    encodeAttachment({ gid: new Uint8Array(16).fill(publisher), sequenceNumber: 1n, sourceTimestamp: 0n }, layout) };
}

describe("received topic traffic", () => {
  it("counts every arrival in a burst, separates both attachment layouts, and measures payload bandwidth", () => {
    const traffic = new TopicTraffic(0);
    for (let i = 0; i < 1000; i++) traffic.record(sample(100, 1), 500);
    for (let i = 0; i < 20; i++) traffic.record(sample(250, 2, "labelled"), 750);
    const s = traffic.snapshot(1000);
    expect(s).toMatchObject({ count: 1020, bytes: 105000, hz: 1020, bytesPerSecond: 105000 });
    expect(s.publishers).toEqual([
      { id: "01".repeat(16), count: 1000, bytes: 100000, hz: 1000, bytesPerSecond: 100000 },
      { id: "02".repeat(16), count: 20, bytes: 5000, hz: 20, bytesPerSecond: 5000 },
    ]);
  });

  it("expires idle rates without losing cumulative counts; restart traffic uses a five-second window", () => {
    const traffic = new TopicTraffic(0);
    traffic.record(sample(100, 1), 100);
    expect(traffic.snapshot(100).hz).toBe(10);
    expect(traffic.snapshot(5100)).toMatchObject({ count: 1, bytes: 100, hz: 0, bytesPerSecond: 0 });
    expect(traffic.snapshot(5100).publishers[0].hz).toBe(0);
    traffic.record(sample(50, 1), 10000);
    expect(traffic.snapshot(10000)).toMatchObject({ count: 2, bytes: 150, hz: 0.2, bytesPerSecond: 10 });
  });

  it("does not guess a node for missing/malformed IDs and ignores delete events", () => {
    const traffic = new TopicTraffic(0);
    traffic.record(sample(100), 10);
    traffic.record({ ...sample(50), attachment: new Uint8Array([99]) }, 20);
    traffic.record({ ...sample(999), kind: "delete" }, 30);
    expect(traffic.snapshot(1000).publishers).toEqual([
      { id: "unattributed", count: 2, bytes: 150, hz: 2, bytesPerSecond: 150 },
    ]);
    expect(Number.isFinite(traffic.snapshot(0).hz)).toBe(true);
  });

  it("bounds publisher churn while preserving totals and overflow traffic", () => {
    const traffic = new TopicTraffic(0);
    for (let i = 0; i < 300; i++) {
      const gid = new Uint8Array(16);
      new DataView(gid.buffer).setUint32(0, i, true);
      traffic.record({ ...sample(10), attachment: encodeAttachment({ gid, sequenceNumber: 1n, sourceTimestamp: 0n }) }, i);
    }
    const s = traffic.snapshot(1000);
    expect(s.publishers).toHaveLength(257);
    expect(s.count).toBe(300);
    expect(s.publishers.find((p) => p.id === "overflow")?.count).toBe(44);
  });
});
