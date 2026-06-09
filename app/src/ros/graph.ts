// The rmw_zenoh ROS graph, reconstructed from its liveliness tokens — the same mechanism the rmw's
// own graph cache uses, so the dashboard sees exactly what `ros2 topic list` would. Formats verified
// against rmw_zenoh jazzy liveliness_utils.cpp:
//
//   @ros2_lv/<domain>/<zid>/<nid>/<eid>/<kind>/<enclave>/<namespace>/<node>[/<topic>/<type>/<hash>/<qos>]
//
// kind ∈ NN (node) | MP (publisher) | MS (subscription) | SS (service server) | SC (service client);
// enclave/namespace/node/topic/type/hash segments mangle '/' → '%'; qos = ':'-joined
// reliability:durability:history,depth:deadline:lifespan:liveliness with numeric rmw enum values and
// empty fields meaning "matches rmw_qos_profile_default" (reliable / volatile / keep_last,10).

import { ddsToRosName } from "../schema/typeName";

export const ROS2_LIVELINESS_GLOB = "@ros2_lv/**";

export type EntityKind = "NN" | "MP" | "MS" | "SS" | "SC";

export interface QosInfo {
  /** undefined = unparsed/unknown; empty fields in the token mean the rmw default. */
  reliability?: "reliable" | "best_effort";
  durability?: "volatile" | "transient_local";
  depth?: number;
  raw: string;
}

export interface LivelinessEntity {
  keyexpr: string;
  kind: EntityKind;
  domainId: number;
  zid: string;
  nid: string;
  eid: string;
  namespace: string; // demangled, "/" for root
  nodeName: string;
  nodeFq: string; // "/ns/node" | "/node"
  topic?: { name: string; typeDds: string; typeHash: string; qos: QosInfo };
}

const KINDS = new Set<string>(["NN", "MP", "MS", "SS", "SC"]);

const demangle = (s: string) => s.replaceAll("%", "/");

// rmw enum values, from rmw/types.h (rmw_zenoh writes them with std::to_string).
function parseQos(raw: string): QosInfo {
  const qos: QosInfo = { raw };
  const fields = raw.split(":");
  if (fields.length < 3) return qos;
  const [rel, dur, hist] = fields;
  if (rel === "" || rel === "1") qos.reliability = "reliable";
  else if (rel === "2") qos.reliability = "best_effort";
  if (dur === "" || dur === "2") qos.durability = "volatile";
  else if (dur === "1") qos.durability = "transient_local";
  const depth = hist.split(",")[1];
  qos.depth = depth === "" ? 10 : /^\d+$/.test(depth ?? "") ? Number(depth) : undefined;
  return qos;
}

export function parseLivelinessToken(keyexpr: string): LivelinessEntity | null {
  const parts = keyexpr.split("/");
  // 9 segments for NN, 13 when topic/service info is appended (KeyexprIndex in rmw_zenoh).
  if (parts[0] !== "@ros2_lv" || (parts.length !== 9 && parts.length !== 13)) return null;
  if (parts.some((p) => p === "")) return null;
  const [, domain, zid, nid, eid, kind] = parts;
  if (!/^\d+$/.test(domain) || !KINDS.has(kind)) return null;
  if (kind === "NN" ? parts.length !== 9 : parts.length !== 13) return null;
  const namespace = demangle(parts[7]);
  const nodeName = demangle(parts[8]);
  const entity: LivelinessEntity = {
    keyexpr,
    kind: kind as EntityKind,
    domainId: Number(domain),
    zid,
    nid,
    eid,
    namespace,
    nodeName,
    nodeFq: namespace === "/" ? `/${nodeName}` : `${namespace}/${nodeName}`,
  };
  if (parts.length === 13) {
    entity.topic = {
      name: demangle(parts[9]),
      typeDds: demangle(parts[10]),
      typeHash: demangle(parts[11]),
      qos: parseQos(parts[12]),
    };
  }
  return entity;
}

export interface TopicEntry {
  name: string;
  typeDds: string;
  typeName: string; // ROS form when demangleable, else the raw DDS name
  typeHash: string;
  domainId: number;
  publishers: LivelinessEntity[];
  subscribers: LivelinessEntity[];
  /** Any publisher is transient_local → a `get` on the keyexpr can fetch the latched value. */
  transientLocal: boolean;
  bestEffort: boolean;
  /** The rmw_zenoh data keyexpr this topic's samples flow on. */
  dataKeyexpr: string;
}

export interface ServiceEntry {
  name: string;
  typeName: string;
  servers: LivelinessEntity[];
  clients: LivelinessEntity[];
}

export interface RosGraph {
  domains: number[];
  nodes: LivelinessEntity[]; // NN entities
  topics: TopicEntry[];
  services: ServiceEntry[];
  tokenCount: number;
}

export const EMPTY_GRAPH: RosGraph = { domains: [], nodes: [], topics: [], services: [], tokenCount: 0 };

export function buildGraph(tokens: Iterable<string>): RosGraph {
  const nodes: LivelinessEntity[] = [];
  const topics = new Map<string, TopicEntry>();
  const services = new Map<string, ServiceEntry>();
  const domains = new Set<number>();
  let tokenCount = 0;

  for (const keyexpr of tokens) {
    const e = parseLivelinessToken(keyexpr);
    if (!e) continue;
    tokenCount++;
    domains.add(e.domainId);
    if (e.kind === "NN") {
      nodes.push(e);
      continue;
    }
    if (!e.topic) continue;
    const t = e.topic;
    if (e.kind === "MP" || e.kind === "MS") {
      const id = `${e.domainId}|${t.name}|${t.typeDds}|${t.typeHash}`;
      let entry = topics.get(id);
      if (!entry) {
        entry = {
          name: t.name,
          typeDds: t.typeDds,
          typeName: ddsToRosName(t.typeDds) ?? t.typeDds,
          typeHash: t.typeHash,
          domainId: e.domainId,
          publishers: [],
          subscribers: [],
          transientLocal: false,
          bestEffort: false,
          // Data keys carry the topic minus its leading slash (strip_slashes in rmw_zenoh).
          dataKeyexpr: `${e.domainId}/${t.name.replace(/^\//, "")}/${t.typeDds}/${t.typeHash}`,
        };
        topics.set(id, entry);
      }
      if (e.kind === "MP") {
        entry.publishers.push(e);
        if (t.qos.durability === "transient_local") entry.transientLocal = true;
        if (t.qos.reliability === "best_effort") entry.bestEffort = true;
      } else {
        entry.subscribers.push(e);
      }
    } else {
      const id = `${e.domainId}|${t.name}|${t.typeDds}`;
      let entry = services.get(id);
      if (!entry) {
        entry = { name: t.name, typeName: ddsToRosName(t.typeDds) ?? t.typeDds, servers: [], clients: [] };
        services.set(id, entry);
      }
      (e.kind === "SS" ? entry.servers : entry.clients).push(e);
    }
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  nodes.sort((a, b) => a.nodeFq.localeCompare(b.nodeFq));
  return {
    domains: [...domains].sort((a, b) => a - b),
    nodes,
    topics: [...topics.values()].sort(byName),
    services: [...services.values()].sort(byName),
    tokenCount,
  };
}
