import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { useStreams } from "./useStreams";
import { StreamSessionPool } from "./pool/sessionPool";
import { createSource } from "./source/registry";
import type { DiscoveredStream } from "./types";

export interface StreamsContextValue {
  /** One StreamDiscovery for the whole app — Home widgets and the Cameras tab share it. */
  streams: DiscoveredStream[];
  /** One refcounted WebRTC session per stream key, shared by every tile that renders it. */
  pool: StreamSessionPool;
}

const Ctx = createContext<StreamsContextValue | null>(null);

export function StreamsProvider({ children }: { children: ReactNode }) {
  const { transport } = useTransportContext();
  const streams = useStreams(transport);
  const pool = useMemo(() => new StreamSessionPool({ createSource }), []);
  useEffect(() => pool.updateStreams(streams), [pool, streams]);
  useEffect(() => () => pool.closeAll(), [pool]);
  const value = useMemo(() => ({ streams, pool }), [streams, pool]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStreamsContext(): StreamsContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStreamsContext must be used inside <StreamsProvider>");
  return v;
}
