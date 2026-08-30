import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { FlavorResolver } from "../schema/resolver";
import type { SchemaResolver } from "../schema/types";
import { useRosGraph } from "./useRosGraph";
import type { RosGraph } from "./graph";

export interface RosGraphContextValue {
  /** One liveliness-fed graph for the whole app — Home widgets and the ROS tab share it. */
  graph: RosGraph;
  /** Shared decoder cache (one type is fetched + compiled at most once, app-wide). */
  resolver: SchemaResolver | null;
}

const Ctx = createContext<RosGraphContextValue | null>(null);

export function RosGraphProvider({ children }: { children: ReactNode }) {
  const { transport } = useTransportContext();
  const graph = useRosGraph(transport);
  const resolver = useMemo(() => (transport ? new FlavorResolver(transport) : null), [transport]);
  return <Ctx.Provider value={{ graph, resolver }}>{children}</Ctx.Provider>;
}

export function useRosGraphContext(): RosGraphContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRosGraphContext must be used inside <RosGraphProvider>");
  return v;
}
