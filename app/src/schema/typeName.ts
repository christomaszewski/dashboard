// rmw_zenoh puts the DDS-mangled typesupport name in its keyexprs (rmw_zenoh type_support_common.cpp
// _create_type_name): `<pkg>::<category>::dds_::<Name>_`, e.g. "std_msgs::msg::dds_::String_".
// The ROS-facing forms are "std_msgs/msg/String" (full) and "std_msgs/String" (short — how
// @foxglove/rosmsg-msgs-common keys its definition maps).

export interface RosTypeName {
  pkg: string;
  category: "msg" | "srv" | "action";
  name: string; // "String"
}

export function parseDdsTypeName(dds: string): RosTypeName | null {
  const parts = dds.split("::");
  if (parts.length !== 4 || parts[2] !== "dds_" || !parts[3].endsWith("_")) return null;
  const [pkg, category] = parts;
  if (category !== "msg" && category !== "srv" && category !== "action") return null;
  return { pkg, category, name: parts[3].slice(0, -1) };
}

/** "std_msgs::msg::dds_::String_" → "std_msgs/msg/String" (null if not a DDS-mangled name). */
export function ddsToRosName(dds: string): string | null {
  const t = parseDdsTypeName(dds);
  return t ? `${t.pkg}/${t.category}/${t.name}` : null;
}

/** "std_msgs/msg/String" | "std_msgs/String" → "std_msgs/String" (the msgs-common map key). */
export function shortTypeName(rosName: string): string {
  const parts = rosName.split("/");
  if (parts.length === 3) return `${parts[0]}/${parts[2]}`;
  return rosName;
}
