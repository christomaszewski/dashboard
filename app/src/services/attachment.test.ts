import { describe, expect, it } from "vitest";
import { GID_LENGTH, decodeAttachment, encodeAttachment } from "./attachment";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe("rmw attachment", () => {
  const gid = Uint8Array.from({ length: GID_LENGTH }, (_v, i) => i + 1);

  it("produces the exact 77-byte layout (labels ULEB-prefixed, int64 LE, gid length-prefixed)", () => {
    const bytes = encodeAttachment({
      sequenceNumber: 0x0102030405060708n,
      sourceTimestamp: 42n,
      gid,
    });
    expect(bytes).toHaveLength(77);
    // "sequence_number" (15 chars) with a 1-byte ULEB length
    expect(bytes[0]).toBe(15);
    expect([...bytes.slice(1, 16)]).toEqual(ascii("sequence_number"));
    // int64 little-endian
    expect([...bytes.slice(16, 24)]).toEqual([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
    // "source_timestamp" (16 chars)
    expect(bytes[24]).toBe(16);
    expect([...bytes.slice(25, 41)]).toEqual(ascii("source_timestamp"));
    expect([...bytes.slice(41, 49)]).toEqual([42, 0, 0, 0, 0, 0, 0, 0]);
    // "source_gid" (10 chars) then the 16-byte sequence with its own length prefix
    expect(bytes[49]).toBe(10);
    expect([...bytes.slice(50, 60)]).toEqual(ascii("source_gid"));
    expect(bytes[60]).toBe(GID_LENGTH);
    expect([...bytes.slice(61)]).toEqual([...gid]);
  });

  it("round-trips", () => {
    const a = { sequenceNumber: 7n, sourceTimestamp: 1_700_000_000_000_000_000n, gid };
    expect(decodeAttachment(encodeAttachment(a))).toEqual(a);
  });

  it("rejects a wrong gid length on encode", () => {
    expect(() => encodeAttachment({ sequenceNumber: 1n, sourceTimestamp: 1n, gid: new Uint8Array(8) })).toThrow(/16/);
  });

  it("rejects label mismatches and truncation on decode", () => {
    const bytes = encodeAttachment({ sequenceNumber: 1n, sourceTimestamp: 2n, gid });
    const corrupted = bytes.slice();
    corrupted[1] = "x".charCodeAt(0); // sequence_number → xequence_number
    expect(() => decodeAttachment(corrupted)).toThrow(/label mismatch/);
    expect(() => decodeAttachment(bytes.slice(0, 40))).toThrow();
  });
});
