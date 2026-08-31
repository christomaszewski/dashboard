import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
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
}

const Ctx = createContext<RosGraphContextValue | null>(null);

export function RosGraphProvider({ children }: { children: ReactNode }) {
  const { transport } = useTransportContext();
  const graph = useRosGraph(transport);
  const resolver = useMemo(() => (transport ? new FlavorResolver(transport) : null), [transport]);
  const store = useMemo(
    () => (transport && resolver ? new TopicStore({ transport, resolver }) : null),
    [transport, resolver],
  );
  useEffect(() => () => store?.closeAll(), [store]);
  const value = useMemo(() => ({ graph, resolver, store }), [graph, resolver, store]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRosGraphContext(): RosGraphContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRosGraphContext must be used inside <RosGraphProvider>");
  return v;
}
