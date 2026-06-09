import type { TypeIdentity } from "./types";
import { ddsToRosName } from "./typeName";

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

const RIHS_RE = /^RIHS01_[0-9a-f]{64}$/;

/**
 * rmw_zenoh data keyexpr (verified against jazzy liveliness_utils.cpp, Entity ctor):
 *   <domain_id>/<topic minus leading slash>/<dds type name>/<type hash>
 * e.g. 0/turtle1/cmd_vel/geometry_msgs::msg::dds_::Twist_/RIHS01_<64 hex>. The topic may span
 * multiple segments; the type is the DDS-mangled name (see typeName.ts); the hash is RIHS01_<hex>.
 */
export function parseRos2Key(keyexpr: string): ParsedKey | null {
  const parts = keyexpr.split("/");
  if (parts.length < 4) return null;
  const [domain] = parts;
  const hash = parts[parts.length - 1];
  const ddsType = parts[parts.length - 2];
  if (!/^\d+$/.test(domain) || !RIHS_RE.test(hash)) return null;
  const typeName = ddsToRosName(ddsType);
  if (!typeName) return null;
  return {
    topicName: "/" + parts.slice(1, -2).join("/"),
    identity: { flavor: "ros2", typeName, rihsHash: hash },
  };
}

export function parseKey(keyexpr: string): ParsedKey {
  return (
    parseRos2Key(keyexpr) ??
    parseRos1Key(keyexpr) ?? { topicName: keyexpr, identity: { flavor: "unknown" } }
  );
}
