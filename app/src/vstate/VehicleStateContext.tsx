import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { VehicleStateClient } from "./client";
import type { Transport } from "../transport/types";
import { loadRuntimeKeys, type RuntimeKeys } from "./runtime";

export interface VehicleStateValue {
  /** The instance YAML set `vehicle_state: true`. */
  enabled: boolean;
  /** Null until the runtime key has loaded and a transport exists. */
  client: VehicleStateClient | null;
  /** Why there is no client although vehicle state is enabled. */
  error?: string;
  /** Where image widgets fetch vehicle frames (same transport and service as the client). */
  frames?: { transport: Transport; base: string } | null;
  /** Local run registry, enabled by runtime metadata even when topic projection is disabled. */
  currentRun?: { client: VehicleStateClient | null; vehicleId?: string; error?: string };
}

export const VehicleStateCtx = createContext<VehicleStateValue>({ enabled: false, client: null });

export function useVehicleState(): VehicleStateValue {
  return useContext(VehicleStateCtx);
}

/** Which path a widget's topics take. Home sets it per widget; everything else stays direct. */
export type TopicSource = "vehicle" | "direct";
export const TopicSourceCtx = createContext<TopicSource>("direct");

/** Home with vehicle state on: this widget's ROS data comes from the vehicle. */
export function useViaVehicle(): boolean {
  const source = useContext(TopicSourceCtx);
  const vehicle = useContext(VehicleStateCtx);
  return source === "vehicle" && vehicle.enabled;
}

/** A widget's own `vehicle_state` setting over the surrounding one (a panel's, or the default). */
export function WidgetTopicSource({ setting, children }: { setting: boolean | undefined; children: ReactNode }) {
  const inherited = useContext(TopicSourceCtx);
  const source: TopicSource = setting === undefined ? inherited : setting ? "vehicle" : "direct";
  return <TopicSourceCtx.Provider value={source}>{children}</TopicSourceCtx.Provider>;
}

export function VehicleStateProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { transport } = useTransportContext();
  const [keys, setKeys] = useState<RuntimeKeys | null>(null);
  const [clients, setClients] = useState<{ client: VehicleStateClient | null; runClient: VehicleStateClient | null }>({ client: null, runClient: null });

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const attempt = () =>
      void loadRuntimeKeys(fetch, import.meta.env.VITE_VEHICLE_STATE_KEY).then((result) => {
        if (cancelled) return;
        setKeys(result);
        if ((enabled && result.error) || result.currentRunError || result.retry) retry = setTimeout(attempt, 5000);
      });
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [enabled]);

  const base = enabled && !keys?.error ? keys?.base : undefined;
  const runBase = keys?.currentRunBase;
  useEffect(() => {
    const client = transport && base ? new VehicleStateClient({ transport, base }) : null;
    const runClient = runBase === base ? client : transport && runBase ? new VehicleStateClient({ transport, base: runBase }) : null;
    setClients({ client, runClient });
    return () => { client?.close(); if (runClient !== client) runClient?.close(); };
  }, [transport, base, runBase]);

  const error = enabled ? keys?.error : undefined;
  const frames = useMemo(() => (enabled && transport && base ? { transport, base } : null), [enabled, transport, base]);
  const runError = keys?.currentRunError;
  const currentRun = useMemo(() => runBase || runError ? { client: clients.runClient,
    vehicleId: runBase?.match(/^fleet\/([^/]+)\/dash\//)?.[1], error: runError } : undefined, [runBase, runError, clients.runClient]);
  const value = useMemo(() => ({ enabled, client: clients.client, error, frames, currentRun }), [enabled, clients.client, error, frames, currentRun]);
  return <VehicleStateCtx.Provider value={value}>{children}</VehicleStateCtx.Provider>;
}
