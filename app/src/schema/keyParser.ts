import type { TypeIdentity } from "./types";

export interface ParsedKey {
  topicName: string;
  identity: TypeIdentity;
}

function hexToUtf8(hex: string): string {
  const pairs = hex.match(/.{1,2}/g) ?? [];
  return new TextDecoder().decode(Uint8Array.from(pairs.map((b) => parseInt(b, 16))));
}

/**
 * zenoh-bridge-ros1 maps a topic to:  <hex(datatype)>/<md5>/<bridge_ns>/<topic...>
 * (datatype is hex-encoded because it contains '/', e.g. "sensor_msgs/Image"). Verified against
 * zenoh-plugin-ros1 topic_utilities.rs (ros_mapping_format).
 */
export function parseRos1Key(keyexpr: string): ParsedKey | null {
  const parts = keyexpr.split("/");
  if (parts.length < 4) return null;
  const [dataTypeHex, md5] = parts;
  if (!/^[0-9a-fA-F]+$/.test(dataTypeHex) || !/^[0-9a-f]{32}$/.test(md5)) return null;
  let typeName: string;
  try {
    typeName = hexToUtf8(dataTypeHex);
  } catch {
    return null;
  }
  if (!typeName.includes("/")) return null; // ROS type names look like "pkg/Msg"
  return { topicName: "/" + parts.slice(3).join("/"), identity: { flavor: "ros1", typeName, md5 } };
}

/**
 * TODO(ros2): parse the rmw_zenoh key mangling (domain / entity / type / type_hash). Verify the exact
 * format against a live graph or rmw_zenoh source before relying on it; until then ROS2 keys fall
 * through to `unknown` and are shown raw.
 */
export function parseRos2Key(_keyexpr: string): ParsedKey | null {
  return null;
}

export function parseKey(keyexpr: string): ParsedKey {
  return (
    parseRos2Key(keyexpr) ??
    parseRos1Key(keyexpr) ?? { topicName: keyexpr, identity: { flavor: "unknown" } }
  );
}
