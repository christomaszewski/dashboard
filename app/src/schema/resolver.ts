import type { Decoder, SchemaResolver, TypeIdentity } from "./types";
import type { Transport } from "../transport/types";

function cacheKey(id: TypeIdentity): string {
  switch (id.flavor) {
    case "ros2":
      return `ros2:${id.rihsHash}`;
    case "ros1":
      return `ros1:${id.md5}`;
    default:
      return "unknown";
  }
}

/**
 * Resolves a TypeIdentity → Decoder, cached by structural fingerprint (RIHS / md5): a type is
 * fetched + compiled at most once, ever.
 *
 * Current backend: bundled common-interface definitions looked up by type name (staticDefs.ts) —
 * covers the stock sensor stack; the RIHS/md5 fingerprint is only the cache key, so a vehicle whose
 * interfaces drifted from the bundle still decodes (watch Decoder.lastWarning for trailing bytes).
 *
 * Future backend for non-bundled (vendor) types, why `transport` is kept: ROS2's own
 * `~/get_type_description` service over the bus. Needs (a) attachment support on Transport.get —
 * rmw_zenoh service servers parse a client attachment (sequence_number/source_timestamp/gid,
 * attachment_helpers.cpp) — and (b) hand-rolled CDR for the GetTypeDescription request/response
 * (rosmsg2-serialization MessageWriter + the srv schema). Verify against a live vehicle.
 */
export class FlavorResolver implements SchemaResolver {
  private readonly cache = new Map<string, Promise<Decoder>>();

  constructor(private readonly transport: Transport) {}

  resolve(id: TypeIdentity): Promise<Decoder> {
    const key = cacheKey(id);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.build(id);
      // A failed build (e.g. defs chunk failed to load) shouldn't poison the cache forever.
      pending.catch(() => this.cache.delete(key));
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async build(id: TypeIdentity): Promise<Decoder> {
    void this.transport; // reserved: the get_type_description backend fetches over the transport
    switch (id.flavor) {
      case "ros2": {
        const { buildRos2StaticDecoder } = await import("./decoders/staticDefs");
        return buildRos2StaticDecoder(id.typeName);
      }
      case "ros1": {
        const { buildRos1StaticDecoder } = await import("./decoders/staticDefs");
        return buildRos1StaticDecoder(id.typeName);
      }
      default:
        throw new Error("unknown flavor: no decoder");
    }
  }
}
