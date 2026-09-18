// The rmw_zenoh attachment on every sample, request and reply: sequence number, source timestamp,
// source gid — written with the zenoh ext serializer (ULEB128-prefixed sequences and strings,
// little-endian fixed-width integers). TWO layouts exist, and a SERVER that receives the wrong one
// DIES: rmw_zenoh parses the attachment inside its query callback and the resulting
// zenoh::ZException / std::runtime_error is uncaught. Measured on the bench (2026-09-07): a rosbag2
// recorder on rmw_zenoh 0.10.5 terminated with "Incorrect sequence size" on the dashboard's first
// labelled query.
//
//   plain     rmw_zenoh 0.10 (ROS 2 Lyrical — the fleet's). 33 bytes:
//               int64 LE sequence_number | int64 LE source_timestamp (ns) | uleb 16 + gid
//   labelled  rmw_zenoh 0.2 (ROS 2 Jazzy, attachment_helpers.cpp). 77 bytes:
//               uleb "sequence_number" int64 | uleb "source_timestamp" int64 | uleb "source_gid" uleb 16 + gid
//
// `rmw_attachment:` in the instance config picks the layout the dashboard SENDS (default plain).
// Decoding sniffs the layout, so the Bus debug attachment column shows which one the vehicle's own
// nodes speak — check it against the config before the first service call on a new fleet.
import { ZBytesDeserializer, ZBytesSerializer } from "@eclipse-zenoh/zenoh-ts/ext";

/** RMW_GID_STORAGE_SIZE since Iron (Humble used 24). */
export const GID_LENGTH = 16;

export type AttachmentLayout = "plain" | "labelled";
export const ATTACHMENT_LAYOUTS: readonly AttachmentLayout[] = ["plain", "labelled"];
export const PLAIN_LENGTH = 8 + 8 + 1 + GID_LENGTH; // 33
export const LABELLED_LENGTH = PLAIN_LENGTH + (1 + 15) + (1 + 16) + (1 + 10); // 77

let sendLayout: AttachmentLayout = "plain";
/** The layout every query from this page carries from now on (`rmw_attachment:` in the config). */
export function setAttachmentLayout(layout: AttachmentLayout): void {
  sendLayout = layout;
}
export function attachmentLayout(): AttachmentLayout {
  return sendLayout;
}

export interface RmwAttachment {
  sequenceNumber: bigint;
  /** Nanoseconds since epoch. */
  sourceTimestamp: bigint;
  /** GID_LENGTH bytes. */
  gid: Uint8Array;
}

export interface DecodedAttachment extends RmwAttachment {
  /** The layout the bytes were in — what the sender's rmw_zenoh speaks. */
  layout: AttachmentLayout;
}

export function encodeAttachment(a: RmwAttachment, layout: AttachmentLayout = sendLayout): Uint8Array {
  if (a.gid.length !== GID_LENGTH) throw new Error(`gid must be ${GID_LENGTH} bytes, got ${a.gid.length}`);
  const labelled = layout === "labelled";
  const s = new ZBytesSerializer();
  if (labelled) s.serializeString("sequence_number");
  s.serializeBigintInt64(a.sequenceNumber);
  if (labelled) s.serializeString("source_timestamp");
  s.serializeBigintInt64(a.sourceTimestamp);
  if (labelled) s.serializeString("source_gid");
  s.serializeUint8Array(a.gid);
  return s.finish().toBytes();
}

const LABEL_0 = "sequence_number";

/** Which layout `bytes` is in: labelled starts with the ULEB-prefixed first label; a plain
 *  attachment cannot (its first 16 bytes are two integers that would have to spell it). */
export function sniffAttachmentLayout(bytes: Uint8Array): AttachmentLayout {
  if (bytes.length > LABEL_0.length && bytes[0] === LABEL_0.length) {
    if (new TextDecoder().decode(bytes.subarray(1, 1 + LABEL_0.length)) === LABEL_0) return "labelled";
  }
  return "plain";
}

export function decodeAttachment(bytes: Uint8Array): DecodedAttachment {
  const layout = sniffAttachmentLayout(bytes);
  const want = layout === "labelled" ? LABELLED_LENGTH : PLAIN_LENGTH;
  if (bytes.length !== want) {
    throw new Error(`not an rmw attachment: ${bytes.length} bytes (${layout} layout is ${want}; plain ${PLAIN_LENGTH} / labelled ${LABELLED_LENGTH})`);
  }
  const d = new ZBytesDeserializer(bytes);
  const expect = (label: string) => {
    const got = d.deserializeString();
    if (got !== label) throw new Error(`attachment label mismatch: expected '${label}', got '${got}'`);
  };
  const labelled = layout === "labelled";
  if (labelled) expect("sequence_number");
  const sequenceNumber = d.deserializeBigintInt64();
  if (labelled) expect("source_timestamp");
  const sourceTimestamp = d.deserializeBigintInt64();
  if (labelled) expect("source_gid");
  const gid = d.deserializeUint8Array();
  if (gid.length !== GID_LENGTH) throw new Error(`attachment gid is ${gid.length} bytes, expected ${GID_LENGTH}`);
  return { sequenceNumber, sourceTimestamp, gid, layout };
}
