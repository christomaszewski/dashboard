import { useEffect, useMemo, useState } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { useTabActive } from "../shell/TabActivity";
import { EMPTY_GRAPH, buildGraph, type RosGraph } from "./graph";
import { useRosGraphContext } from "./RosGraphContext";
import { useViaVehicle } from "../vstate/VehicleStateContext";

// Narrow liveliness queries instead of the whole `@ros2_lv/**` graph, for widgets that need a few
// entities (a service button, a recorder, the image topics): a one-shot `get` per pattern, refreshed
// while the view is visible. Token layout (rmw_zenoh):
//   @ros2_lv/<domain>/<zid>/<nid>/<eid>/<kind>/<enclave>/<namespace>/<node>/<name>/<type>/<hash>/<qos>…
const mangle = (name: string) => name.replaceAll("/", "%");

/** The servers of one service, by its full name. */
export const serviceQuery = (name: string) => `@ros2_lv/*/*/*/*/SS/*/*/*/${mangle(name)}/**`;
/** Servers of every service whose name ends with `/<leaf>` (a recorder's `is_paused`, say). */
export const serviceLeafQuery = (leaf: string) => `@ros2_lv/*/*/*/*/SS/*/*/*/$*%${mangle(leaf)}/**`;
/** Every service under one node base (`/bag_logger/rosbag2_recorder` → its pause, is_paused, …). */
export const servicePrefixQuery = (base: string) => `@ros2_lv/*/*/*/*/SS/*/*/*/${mangle(base)}%$*/**`;
/** Publishers of every topic of one DDS type (`sensor_msgs::msg::dds_::Image_`). */
export const publisherTypeQuery = (ddsType: string) => `@ros2_lv/*/*/*/*/MP/*/*/*/*/${ddsType}/**`;

const REFRESH_MS = 15_000;

/**
 * A RosGraph built from `queries` (null = none). `withServerNodes` also fetches every service of
 * each server's node, so its `~/get_type_description` is known (vendor service types).
 */
export function useLivelinessGraph(queries: readonly string[] | null, opts: { withServerNodes?: boolean } = {}): RosGraph {
  const { transport, status } = useTransportContext();
  const active = useTabActive();
  const [graph, setGraph] = useState<RosGraph>(EMPTY_GRAPH);
  const key = queries ? JSON.stringify(queries) : null;
  const withServerNodes = opts.withServerNodes ?? false;

  useEffect(() => {
    if (!key || !transport || !active || status !== "connected") return;
    const patterns = JSON.parse(key) as string[];
    let cancelled = false;
    const run = async () => {
      const tokens = new Set<string>();
      const results = await Promise.allSettled(patterns.map((q) => transport.liveliness.get(q)));
      for (const r of results) if (r.status === "fulfilled") for (const t of r.value) tokens.add(t);
      if (withServerNodes) {
        const nodes = new Set<string>();
        for (const s of buildGraph(tokens).services) for (const e of s.servers) nodes.add(`@ros2_lv/${e.domainId}/${e.zid}/${e.nid}/*/SS/**`);
        const more = await Promise.allSettled([...nodes].map((q) => transport.liveliness.get(q)));
        for (const r of more) if (r.status === "fulfilled") for (const t of r.value) tokens.add(t);
      }
      if (!cancelled) setGraph(buildGraph(tokens));
    };
    void run();
    const timer = setInterval(() => void run(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, transport, active, status, withServerNodes]);

  return useMemo(() => (key ? graph : EMPTY_GRAPH), [key, graph]);
}

/**
 * The graph a widget needs: the shared full graph, or — on Home with vehicle state, where the whole
 * graph is never pulled — one built from `queries`.
 */
export function useScopedGraph(queries: readonly string[], opts: { withServerNodes?: boolean } = {}): RosGraph {
  const via = useViaVehicle();
  const { graph } = useRosGraphContext(!via);
  const targeted = useLivelinessGraph(via ? queries : null, opts);
  return via ? targeted : graph;
}
