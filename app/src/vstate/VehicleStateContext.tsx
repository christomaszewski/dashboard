import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { VehicleStateClient } from "./client";
import { loadStateKey, type StateKeyResult } from "./runtime";

export interface VehicleStateValue {
  /** The instance YAML set `vehicle_state: true`. */
  enabled: boolean;
  /** Null until the runtime key has loaded and a transport exists. */
  client: VehicleStateClient | null;
  /** Why there is no client although vehicle state is enabled. */
  error?: string;
}

export const VehicleStateCtx = createContext<VehicleStateValue>({ enabled: false, client: null });

export function useVehicleState(): VehicleStateValue {
  return useContext(VehicleStateCtx);
}

/** Which path a widget's topics take. Home sets it per widget; everything else stays direct. */
export type TopicSource = "vehicle" | "direct";
export const TopicSourceCtx = createContext<TopicSource>("direct");

/** A widget's own `vehicle_state` setting over the surrounding one (a panel's, or the default). */
export function WidgetTopicSource({ setting, children }: { setting: boolean | undefined; children: ReactNode }) {
  const inherited = useContext(TopicSourceCtx);
  const source: TopicSource = setting === undefined ? inherited : setting ? "vehicle" : "direct";
  return <TopicSourceCtx.Provider value={source}>{children}</TopicSourceCtx.Provider>;
}

export function VehicleStateProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { transport } = useTransportContext();
  const [key, setKey] = useState<StateKeyResult | null>(null);
  const [client, setClient] = useState<VehicleStateClient | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const attempt = () =>
      void loadStateKey(fetch, import.meta.env.VITE_VEHICLE_STATE_KEY).then((result) => {
        if (cancelled) return;
        setKey(result);
        if ("error" in result) retry = setTimeout(attempt, 5000); // the link may just be bad
      });
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [enabled]);

  const base = key && "base" in key ? key.base : undefined;
  useEffect(() => {
    if (!enabled || !transport || !base) return setClient(null);
    const next = new VehicleStateClient({ transport, base });
    setClient(next);
    return () => next.close();
  }, [enabled, transport, base]);

  const error = key && "error" in key ? key.error : undefined;
  const value = useMemo(() => ({ enabled, client, error }), [enabled, client, error]);
  return <VehicleStateCtx.Provider value={value}>{children}</VehicleStateCtx.Provider>;
}
