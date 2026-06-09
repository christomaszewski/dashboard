// Static decode backend: bundled common-interface definitions (@foxglove/rosmsg-msgs-common) +
// the foxglove wire readers. Covers rcl_interfaces/common_interfaces/tf2 — i.e. everything a stock
// sensor stack publishes. Types outside the bundle (vendor drivers) need the dynamic
// get_type_description backend (future increment — see resolver.ts).
//
// The defs module is ~1 MB across 5 distro sets, so it's imported dynamically: the chunk loads on
// first decode, not at dashboard startup.

import type { MessageDefinition } from "@foxglove/message-definition";
import type { Decoder } from "../types";
import { shortTypeName } from "../typeName";

type DefMap = Record<string, MessageDefinition>;

/** Root-first transitive closure of `rootKey` over `all` (field types are fully qualified). */
function collectDefs(rootKey: string, all: DefMap): MessageDefinition[] {
  const out: MessageDefinition[] = [];
  const seen = new Set<string>([rootKey]);
  const queue = [rootKey];
  while (queue.length > 0) {
    const key = queue.shift()!;
    const def = all[key];
    if (!def) throw new Error(`type ${key} is not in the bundled message definitions`);
    out.push(def);
    for (const field of def.definitions) {
      if (field.isComplex === true && !seen.has(field.type)) {
        seen.add(field.type);
        queue.push(field.type);
      }
    }
  }
  return out;
}

interface WireReader {
  readMessage<T = unknown>(buffer: ArrayBufferView): T;
  lastReadHadTrailingBytes(): boolean;
}

function toDecoder(reader: WireReader, typeName: string): Decoder {
  return {
    decode: (bytes) => reader.readMessage(bytes) as Record<string, unknown>,
    lastWarning: () =>
      reader.lastReadHadTrailingBytes()
        ? `decode of ${typeName} left trailing bytes — bundled definition may lag the vehicle's interface version`
        : undefined,
  };
}

/** typeName = "sensor_msgs/msg/Imu" (ROS2 full form). CDR (rmw_zenoh payload) decoder. */
export async function buildRos2StaticDecoder(typeName: string): Promise<Decoder> {
  const [{ ros2jazzy }, { MessageReader }] = await Promise.all([
    import("@foxglove/rosmsg-msgs-common"),
    import("@foxglove/rosmsg2-serialization"),
  ]);
  const defs = collectDefs(shortTypeName(typeName), ros2jazzy as DefMap);
  return toDecoder(new MessageReader(defs), typeName);
}

/** typeName = "sensor_msgs/Imu" (ROS1 form, from zenoh-bridge-ros1 keys). ROS1-wire decoder. */
export async function buildRos1StaticDecoder(typeName: string): Promise<Decoder> {
  const [{ ros1 }, { MessageReader }] = await Promise.all([
    import("@foxglove/rosmsg-msgs-common"),
    import("@foxglove/rosmsg-serialization"),
  ]);
  const defs = collectDefs(shortTypeName(typeName), ros1 as DefMap);
  return toDecoder(new MessageReader(defs), typeName);
}
