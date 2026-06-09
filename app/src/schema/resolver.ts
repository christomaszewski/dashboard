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
 * The decode backends are stubbed — this is the increment right after the transport spine. Wire the
 * foxglove codecs here (add the deps first: see app/README.md):
 *   - ROS2: query the `get_type_description` queryable (via this.transport.get, payload = a CDR
 *           GetTypeDescription request keyed by id.rihsHash) → build a CDR reader from the returned
 *           TypeDescription (@foxglove/rosmsg2-serialization + @foxglove/cdr).
 *   - ROS1: query the companion md5→full_text advertiser (this.transport.get) → parse the .msg text
 *           (@foxglove/rosmsg) → build a ROS1-wire reader (@foxglove/rosmsg-serialization).
 */
export class FlavorResolver implements SchemaResolver {
  private readonly cache = new Map<string, Promise<Decoder>>();

  constructor(private readonly transport: Transport) {}

  resolve(id: TypeIdentity): Promise<Decoder> {
    const key = cacheKey(id);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.build(id);
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async build(id: TypeIdentity): Promise<Decoder> {
    void this.transport; // reserved: backends fetch their schema over the transport (see class doc)
    switch (id.flavor) {
      case "ros2":
        throw new Error(`ros2 decode not implemented yet (type=${id.typeName}, rihs=${id.rihsHash})`);
      case "ros1":
        throw new Error(`ros1 decode not implemented yet (type=${id.typeName}, md5=${id.md5})`);
      default:
        throw new Error("unknown flavor: no decoder");
    }
  }
}
