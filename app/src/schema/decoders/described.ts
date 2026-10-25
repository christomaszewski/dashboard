// Topic types outside the bundle (vendor drivers, project messages): described by a node that uses
// the exact type (name + RIHS hash) through its own ~/get_type_description, then CDR-decoded with the
// returned definitions. Any publisher or subscriber of the type can describe it; the first that
// answers wins. Imported on demand, like the bundled definitions.
import { MessageReader } from "@foxglove/rosmsg2-serialization";
import type { LivelinessEntity, RosGraph } from "../../ros/graph";
import type { Transport } from "../../transport/types";
import { describeType } from "../../services/describeType";
import { typeDescriptionToDefinitions } from "../../services/typeDescription";
import type { Decoder } from "../types";

/** Nodes worth asking, one entity per node: publishers first (they certainly hold the type). */
export function typeHolders(graph: RosGraph, typeName: string, typeHash: string): LivelinessEntity[] {
  const out: LivelinessEntity[] = [];
  const seen = new Set<string>();
  for (const pick of ["publishers", "subscribers"] as const) {
    for (const topic of graph.topics) {
      if (topic.typeName !== typeName || topic.typeHash !== typeHash) continue;
      for (const e of topic[pick]) {
        const node = `${e.domainId}/${e.zid}/${e.nid}`;
        if (seen.has(node)) continue;
        seen.add(node);
        out.push(e);
      }
    }
  }
  return out;
}

export async function buildRos2DescribedDecoder(
  transport: Transport,
  graph: RosGraph,
  typeName: string,
  typeHash: string,
  maxNodes = 3,
): Promise<Decoder> {
  const holders = typeHolders(graph, typeName, typeHash);
  if (holders.length === 0) throw new Error(`${typeName} is not bundled, and no node using it is in the graph yet`);
  const reasons: string[] = [];
  for (const holder of holders.slice(0, maxNodes)) {
    const described = await describeType(transport, graph, holder, typeName, typeHash);
    if (!described.ok) {
      reasons.push(described.reason);
      continue;
    }
    const reader = new MessageReader(typeDescriptionToDefinitions(described.description));
    return {
      decode: (bytes) => reader.readMessage(bytes) as Record<string, unknown>,
      lastWarning: () =>
        reader.lastReadHadTrailingBytes()
          ? `decode of ${typeName} left trailing bytes — the described definition does not match the publisher`
          : undefined,
    };
  }
  throw new Error(`${typeName} is not bundled; ${reasons.join("; ")}`);
}
