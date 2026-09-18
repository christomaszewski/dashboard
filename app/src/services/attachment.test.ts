import { afterEach, describe, expect, it } from "vitest";
import {
  GID_LENGTH,
  LABELLED_LENGTH,
  PLAIN_LENGTH,
  attachmentLayout,
  decodeAttachment,
  encodeAttachment,
  setAttachmentLayout,
  sniffAttachmentLayout,
} from "./attachment";

const gid = new Uint8Array(GID_LENGTH).map((_, i) => i + 1);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const bytes = (h: string) => new Uint8Array(h.split(/\s+/).map((x) => parseInt(x, 16)));

/** A sample attachment captured from rmw_zenoh 0.10.5 (ROS 2 Lyrical) on the bench, 2026-09-07:
 *  `ros2 topic pub /bench/ping std_msgs/msg/String` seen through the remote-api sidecar. */
const LYRICAL_SAMPLE = bytes(
  "09 00 00 00 00 00 00 00 df 8a b6 f7 e7 35 d3 18 10 fe 98 e4 a3 b5 4b 6e 59 9c 59 34 f4 cf c2 53 43",
);

afterEach(() => setAttachmentLayout("plain"));

describe("rmw attachment", () => {
  it("decodes what rmw_zenoh 0.10.5 actually sends (plain: int64, int64, uleb-16 gid — 33 bytes) and re-encodes it identically", () => {
    const a = decodeAttachment(LYRICAL_SAMPLE);
    expect(a.layout).toBe("plain");
    expect(a.sequenceNumber).toBe(9n);
    // 2026-09-08T01:5x UTC in nanoseconds
    expect(a.sourceTimestamp / 1_000_000_000n).toBeGreaterThan(1_788_000_000n);
    expect(a.sourceTimestamp / 1_000_000_000n).toBeLessThan(1_789_000_000n);
    expect(hex(a.gid)).toBe("fe 98 e4 a3 b5 4b 6e 59 9c 59 34 f4 cf c2 53 43");
    expect(hex(encodeAttachment(a, "plain"))).toBe(hex(LYRICAL_SAMPLE));
    expect(LYRICAL_SAMPLE).toHaveLength(PLAIN_LENGTH);
  });

  it("plain is the default the page sends; the exact 33-byte layout", () => {
    expect(attachmentLayout()).toBe("plain");
    const b = encodeAttachment({ sequenceNumber: 0x0102030405060708n, sourceTimestamp: 0x1122334455667788n, gid });
    expect(b).toHaveLength(PLAIN_LENGTH);
    expect(hex(b.subarray(0, 8))).toBe("08 07 06 05 04 03 02 01"); // int64 LE
    expect(hex(b.subarray(8, 16))).toBe("88 77 66 55 44 33 22 11");
    expect(b[16]).toBe(16); // uleb gid length
    expect(hex(b.subarray(17))).toBe(hex(gid));
  });

  it("labelled (Jazzy) is the 77-byte layout with ULEB-prefixed labels, selectable per call or app-wide", () => {
    const a = { sequenceNumber: 42n, sourceTimestamp: 1_700_000_000_000_000_000n, gid };
    const b = encodeAttachment(a, "labelled");
    expect(b).toHaveLength(LABELLED_LENGTH);
    expect(b[0]).toBe(15);
    expect(new TextDecoder().decode(b.subarray(1, 16))).toBe("sequence_number");
    expect(b[24]).toBe(16);
    expect(new TextDecoder().decode(b.subarray(25, 41))).toBe("source_timestamp");
    expect(b[49]).toBe(10);
    expect(new TextDecoder().decode(b.subarray(50, 60))).toBe("source_gid");
    expect(b[60]).toBe(16);
    expect(hex(b.subarray(61))).toBe(hex(gid));
    setAttachmentLayout("labelled");
    expect(hex(encodeAttachment(a))).toBe(hex(b));
  });

  it("round-trips both layouts and reports which one the bytes were in", () => {
    const a = { sequenceNumber: -5n, sourceTimestamp: 123n, gid };
    for (const layout of ["plain", "labelled"] as const) {
      const b = encodeAttachment(a, layout);
      expect(sniffAttachmentLayout(b)).toBe(layout);
      expect(decodeAttachment(b)).toEqual({ ...a, layout });
    }
  });

  it("rejects a gid that is not 16 bytes, a wrong length, a corrupted label, and truncation", () => {
    expect(() => encodeAttachment({ sequenceNumber: 1n, sourceTimestamp: 1n, gid: new Uint8Array(8) })).toThrow(/16/);
    const plain = encodeAttachment({ sequenceNumber: 1n, sourceTimestamp: 2n, gid });
    expect(() => decodeAttachment(plain.slice(0, 20))).toThrow(/not an rmw attachment: 20 bytes/);
    expect(() => decodeAttachment(new Uint8Array([...plain, 0]))).toThrow(/34 bytes/);
    const labelled = encodeAttachment({ sequenceNumber: 1n, sourceTimestamp: 2n, gid }, "labelled");
    const corrupted = new Uint8Array(labelled);
    corrupted[30] = 0x41; // inside "source_timestamp"
    expect(() => decodeAttachment(corrupted)).toThrow(/label mismatch/);
    expect(() => decodeAttachment(labelled.slice(0, 40))).toThrow(/not an rmw attachment/);
  });
});
