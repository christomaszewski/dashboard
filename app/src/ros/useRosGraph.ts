import { useEffect, useState } from "react";
import type { Subscription, Transport } from "../transport/types";
import { EMPTY_GRAPH, ROS2_LIVELINESS_GLOB, buildGraph, type RosGraph } from "./graph";

/**
 * Live ROS graph: a liveliness subscriber on `@ros2_lv/**` (history-backed, so cold-start tokens
 * arrive too) folded into a RosGraph. Token add/remove rates are graph-change rates (low), so a full
 * rebuild per event is fine.
 */
export function useRosGraph(transport: Transport | null): RosGraph {
  const [graph, setGraph] = useState<RosGraph>(EMPTY_GRAPH);

  useEffect(() => {
    if (!transport) return;
    let cancelled = false;
    let sub: Subscription | null = null;
    const tokens = new Set<string>();
    transport.liveliness
      .subscribe(ROS2_LIVELINESS_GLOB, (e) => {
        if (e.alive) tokens.add(e.keyexpr);
        else tokens.delete(e.keyexpr);
        setGraph(buildGraph(tokens));
      })
      .then((s) => {
        if (cancelled) void s.close();
        else sub = s;
      });
    return () => {
      cancelled = true;
      void sub?.close();
      setGraph(EMPTY_GRAPH);
    };
  }, [transport]);

  return graph;
}
