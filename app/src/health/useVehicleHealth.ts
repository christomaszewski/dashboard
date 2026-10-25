import { useCallback, useEffect, useRef, useState } from "react";
import type { SeriesPoint } from "../home/widgets/primitives/series";
import type { Transport } from "../transport/types";
import type { VehicleStateClient } from "../vstate/client";
import type { HealthOptions } from "./config";
import { HealthDiscovery, type HealthEvent } from "./discovery";
import type { HealthSeries } from "./useHealth";
import type { HealthService } from "./types";

const NO_POINTS: readonly SeriesPoint[] = [];
// The mirror makes no subscriptions of its own (observe/mirror); it never touches this.
const NO_TRANSPORT = {} as Transport;

/** `ROS 2 · domain 1 · /diagnostics` → its domain and topic, for the instance's health filters. */
function rosOrigin(service: HealthService): { domain?: number; topic?: string } {
  const m = /domain (\d+) · (\/\S*)/.exec(service.sourceLabel ?? "");
  return m ? { domain: Number(m[1]), topic: m[2] } : {};
}

function wanted(service: HealthService, options?: HealthOptions): boolean {
  if (service.source !== "ros2" || !options) return true;
  const { domain, topic } = rosOrigin(service);
  if (options.ros_topics && (topic === undefined || !options.ros_topics.includes(topic))) return false;
  if (options.ros_domains && (domain === undefined || !options.ros_domains.includes(domain))) return false;
  return true;
}

/**
 * Health through vehicle state (docs/VEHICLE_STATE.md, "Health"): the vehicle runs the discovery
 * and every /diagnostics subscription; this page watches the list of services and each service, as
 * changes. A local HealthDiscovery mirrors them, so history, events and staleness work as they do
 * for a page that subscribes itself.
 */
export function useVehicleHealth(client: VehicleStateClient | null, options?: HealthOptions, setupError?: string):
  { services: HealthService[]; series: HealthSeries; events: readonly HealthEvent[]; errors: string[] } {
  const [services, setServices] = useState<HealthService[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const mirrorRef = useRef<HealthDiscovery | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!client) return;
    const mirror = new HealthDiscovery(NO_TRANSPORT);
    mirrorRef.current = mirror;
    mirror.observe((all) => setServices(all.filter((s) => wanted(s, optionsRef.current))));
    const watched = new Map<string, { release(): void; unsubscribe(): void; last?: HealthService }>();
    const index = client.acquire({ health: "*" });
    const sync = () => {
      const snap = client.getSnapshot(index.key);
      setErrors(snap?.error ? [snap.error] : []);
      const keys = new Set(snap?.healthKeys ?? []);
      for (const [key, w] of watched) {
        if (keys.has(key)) continue;
        w.unsubscribe();
        w.release();
        watched.delete(key);
        mirror.forget(key);
      }
      for (const key of keys) {
        if (watched.has(key)) continue;
        const handle = client.acquire({ health: key });
        const entry: { release(): void; unsubscribe(): void; last?: HealthService } = { release: handle.release, unsubscribe: () => undefined };
        const update = () => {
          const service = client.getSnapshot(handle.key)?.health;
          if (!service || service === entry.last) return;
          entry.last = service;
          const ttl = optionsRef.current?.ros_stale_after_s;
          mirror.mirror(service.source === "ros2" && ttl !== undefined ? { ...service, fallbackTtlMs: ttl * 1000 } : service);
        };
        entry.unsubscribe = client.subscribe(handle.key, update);
        watched.set(key, entry);
        update();
      }
    };
    const unsubscribeIndex = client.subscribe(index.key, sync);
    sync();
    return () => {
      unsubscribeIndex();
      index.release();
      for (const w of watched.values()) {
        w.unsubscribe();
        w.release();
      }
      watched.clear();
      void mirror.stop();
      mirrorRef.current = null;
      setServices([]);
    };
  }, [client]);

  const series = useCallback<HealthSeries>(
    (key, statusName, valueKey) => mirrorRef.current?.series(key, statusName, valueKey) ?? NO_POINTS,
    [],
  );
  return {
    services,
    series,
    events: mirrorRef.current?.events ?? [],
    errors: client ? errors : setupError ? [setupError] : [],
  };
}
