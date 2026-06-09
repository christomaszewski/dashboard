// A topic's type identity (the structural fingerprint), discovered from its keyexpr / liveliness.
// ROS2 (rmw_zenoh) is fingerprinted by RIHS hash; ROS1 (bridged) by md5sum.
export type TypeIdentity =
  | { flavor: "ros2"; typeName: string; rihsHash: string }
  | { flavor: "ros1"; typeName: string; md5: string }
  | { flavor: "unknown" };

export type DecodedMessage = Record<string, unknown>;

export interface Decoder {
  decode(bytes: Uint8Array): DecodedMessage;
}

/**
 * Resolve a topic's TypeIdentity to a Decoder. One interface, N self-describing backends:
 *   - ROS2: fetch the schema from the `get_type_description` queryable (keyed by RIHS), CDR decode.
 *   - ROS1: fetch full_text from a companion advertiser (keyed by md5), ROS1-wire decode.
 * Decoders are cached by fingerprint, so a type is resolved at most once.
 */
export interface SchemaResolver {
  resolve(id: TypeIdentity): Promise<Decoder>;
}
