import type { Decoder, SchemaResolver, TypeIdentity } from "./types";
import type { Transport } from "../transport/types";
import type { RosGraph } from "../ros/graph";

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
 * Backends, in order: the bundled common-interface definitions looked up by type name
 * (staticDefs.ts — the stock sensor stack; the RIHS/md5 fingerprint is only the cache key, so a
 * vehicle whose interfaces drifted from the bundle still decodes; watch Decoder.lastWarning), then,
 * for ROS 2 types outside the bundle (vendor drivers, project messages) and only when given the live
 * graph, the description a node using the type returns from its own ~/get_type_description
 * (described.ts). Failures are evicted, so a later resolve asks again.
 */
export interface FlavorResolverOptions {
  /** The live ROS graph: lets types outside the bundle resolve through a node that uses them. */
  graph?: () => RosGraph;
}

export class FlavorResolver implements SchemaResolver {
  private readonly cache = new Map<string, Promise<Decoder>>();

  constructor(
    private readonly transport: Transport,
    private readonly opts: FlavorResolverOptions = {},
  ) {}

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
    switch (id.flavor) {
      case "ros2": {
        const { buildRos2StaticDecoder } = await import("./decoders/staticDefs");
        try {
          return await buildRos2StaticDecoder(id.typeName);
        } catch (notBundled) {
          if (!this.opts.graph) throw notBundled;
          const { buildRos2DescribedDecoder } = await import("./decoders/described");
          return buildRos2DescribedDecoder(this.transport, this.opts.graph(), id.typeName, id.rihsHash);
        }
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
