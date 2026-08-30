// The rmw_zenoh client attachment (attachment_helpers.cpp, Jazzy): three label/value pairs written
// with the zenoh ext serializer — strings and sequences are ULEB128-length-prefixed, integers are
// little-endian fixed width. Servers PARSE this and reject requests whose labels mismatch, and echo
// it (sequence_number = request seq, source_gid = the client's gid) on the reply.
//
// Layout (77 bytes total):
//   uleb "sequence_number"   int64 LE
//   uleb "source_timestamp"  int64 LE (nanoseconds since epoch)
//   uleb "source_gid"        uleb-prefixed 16-byte sequence
//
// Wire-format verification hook: rmw_zenoh publishers attach the same structure to every topic
// sample — decodeAttachment on a live sample validates the layout without touching services.
import { ZBytesDeserializer, ZBytesSerializer } from "@eclipse-zenoh/zenoh-ts/ext";

/** RMW_GID_STORAGE_SIZE in Jazzy. (Pre-Iron rmw used 24 — on-vehicle check if decode rejects.) */
export const GID_LENGTH = 16;

export interface RmwAttachment {
  sequenceNumber: bigint;
  /** Nanoseconds since epoch. */
  sourceTimestamp: bigint;
  /** GID_LENGTH bytes. */
  gid: Uint8Array;
}

export function encodeAttachment(a: RmwAttachment): Uint8Array {
  if (a.gid.length !== GID_LENGTH) throw new Error(`gid must be ${GID_LENGTH} bytes, got ${a.gid.length}`);
  const s = new ZBytesSerializer();
  s.serializeString("sequence_number");
  s.serializeBigintInt64(a.sequenceNumber);
  s.serializeString("source_timestamp");
  s.serializeBigintInt64(a.sourceTimestamp);
  s.serializeString("source_gid");
  s.serializeUint8Array(a.gid);
  return s.finish().toBytes();
}

export function decodeAttachment(bytes: Uint8Array): RmwAttachment {
  const d = new ZBytesDeserializer(bytes);
  const expect = (label: string) => {
    const got = d.deserializeString();
    if (got !== label) throw new Error(`attachment label mismatch: expected '${label}', got '${got}'`);
  };
  expect("sequence_number");
  const sequenceNumber = d.deserializeBigintInt64();
  expect("source_timestamp");
  const sourceTimestamp = d.deserializeBigintInt64();
  expect("source_gid");
  const gid = d.deserializeUint8Array();
  if (gid.length !== GID_LENGTH) throw new Error(`attachment gid is ${gid.length} bytes, expected ${GID_LENGTH}`);
  return { sequenceNumber, sourceTimestamp, gid };
}
