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

/** The raw context — for tests and extensions that provide a value without the live provider. */
export const StreamsCtx = createContext<StreamsContextValue | null>(null);

export function StreamsProvider({ children }: { children: ReactNode }) {
  const { transport } = useTransportContext();
  const streams = useStreams(transport);
  const pool = useMemo(() => new StreamSessionPool({ createSource }), []);
  useEffect(() => pool.updateStreams(streams), [pool, streams]);
  useEffect(() => () => pool.closeAll(), [pool]);
  const value = useMemo(() => ({ streams, pool }), [streams, pool]);
  return <StreamsCtx.Provider value={value}>{children}</StreamsCtx.Provider>;
}

export function useStreamsContext(): StreamsContextValue {
  const v = useContext(StreamsCtx);
  if (!v) throw new Error("useStreamsContext must be used inside <StreamsProvider>");
  return v;
}
