import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTabActive } from "../shell/TabActivity";
import { useTransportContext } from "../transport/TransportContext";
import { FlavorResolver } from "../schema/resolver";
import type { SchemaResolver } from "../schema/types";
import { useRosGraph } from "./useRosGraph";
import { TopicStore } from "./topicStore";
import type { RosGraph } from "./graph";

export interface RosGraphContextValue {
  /** One liveliness-fed graph for the whole app — Home widgets and the ROS tab share it. */
  graph: RosGraph;
  /** Shared decoder cache (one type is fetched + compiled at most once, app-wide). */
  resolver: SchemaResolver | null;
  /** Shared topic subscriptions: N widgets on one topic = one zenoh sub + one decode per flush. */
  store: TopicStore | null;
  /** The graph is subscribed only while someone visible needs it (useRosGraphContext). */
  retain?: () => void;
  release?: () => void;
}

/** Keep the graph this long after the last interested view goes (tab flips, remounts). */
const GRAPH_LINGER_MS = 30_000;

/** The raw context — for tests and extensions that provide a value without the live provider. */
export const RosGraphCtx = createContext<RosGraphContextValue | null>(null);

export function RosGraphProvider({ children }: { children: ReactNode }) {
  const { transport } = useTransportContext();
  // The whole ROS graph (`@ros2_lv/**`) only while a visible view needs it: with vehicle state, Home
  // alone never subscribes, and a reconnect over the radio does not replay every token.
  const [wanted, setWanted] = useState(false);
  const interest = useRef({ count: 0, linger: null as ReturnType<typeof setTimeout> | null });
  const retain = useCallback(() => {
    const i = interest.current;
    i.count += 1;
    if (i.linger !== null) clearTimeout(i.linger);
    i.linger = null;
    setWanted(true);
  }, []);
  const release = useCallback(() => {
    const i = interest.current;
    i.count -= 1;
    if (i.count > 0) return;
    i.linger = setTimeout(() => {
      i.linger = null;
      if (i.count === 0) setWanted(false);
    }, GRAPH_LINGER_MS);
  }, []);
  useEffect(() => () => { if (interest.current.linger !== null) clearTimeout(interest.current.linger); }, []);
  const graph = useRosGraph(wanted ? transport : null);
  // The resolver reads the live graph to find a node that can describe a type outside the bundle.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const resolver = useMemo(
    () => (transport ? new FlavorResolver(transport, { graph: () => graphRef.current }) : null),
    [transport],
  );
  const store = useMemo(
    () => (transport && resolver ? new TopicStore({ transport, resolver }) : null),
    [transport, resolver],
  );
  useEffect(() => () => store?.closeAll(), [store]);
  const value = useMemo(() => ({ graph, resolver, store, retain, release }), [graph, resolver, store, retain, release]);
  return <RosGraphCtx.Provider value={value}>{children}</RosGraphCtx.Provider>;
}

/** The shared graph, store and resolver. `need` (default true) subscribes the graph while this
 *  view's tab is visible; pass false when only the store or resolver is used. */
export function useRosGraphContext(need = true): RosGraphContextValue {
  const v = useContext(RosGraphCtx);
  if (!v) throw new Error("useRosGraphContext must be used inside <RosGraphProvider>");
  const active = useTabActive();
  const { retain, release } = v;
  useEffect(() => {
    if (!need || !active || !retain || !release) return;
    retain();
    return release;
  }, [need, active, retain, release]);
  return v;
}
