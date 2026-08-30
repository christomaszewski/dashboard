// Service query keyexprs for rmw_zenoh (Jazzy). Services are NOT DDS-era rq/rr topic pairs: the
// server declares one queryable and clients `get` it, on a key built by the same scheme as topic
// data keys (graph.ts dataKeyexpr):
//
//   <domain_id>/<service name, leading slash stripped, inner slashes literal>/<pkg::srv::dds_::Name_>/<RIHS01_hash>
//
// The SS liveliness token carries all four pieces verbatim.
import type { LivelinessEntity, RosGraph, ServiceEntry } from "../ros/graph";

/** Query keyexpr for one service server (from its SS token). */
export function serviceQueryKeyexpr(server: LivelinessEntity): string {
  const t = server.topic;
  if (!t) throw new Error(`entity ${server.keyexpr} carries no service info`);
  return `${server.domainId}/${t.name.replace(/^\/+/, "").replace(/\/+$/, "")}/${t.typeDds}/${t.typeHash}`;
}

/** Pick the server entity to dial (prefer the requested domain). */
export function pickServer(entry: ServiceEntry, domainId?: number): LivelinessEntity | undefined {
  if (domainId !== undefined) return entry.servers.find((s) => s.domainId === domainId);
  return entry.servers[0];
}

/**
 * Find the `~/get_type_description` server on the SAME node instance (zid+nid match) as `node` —
 * that node definitionally knows the types it serves. Falls back to any server of the service name.
 */
export function findTypeDescriptionServer(graph: RosGraph, node: LivelinessEntity): LivelinessEntity | undefined {
  const name = `${node.nodeFq}/get_type_description`;
  const entry = graph.services.find((s) => s.name === name);
  if (!entry) return undefined;
  return entry.servers.find((s) => s.zid === node.zid && s.nid === node.nid) ?? entry.servers[0];
}
