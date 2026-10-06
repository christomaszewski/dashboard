import { useCallback, useEffect, useRef, useState } from "react";
import type { SeriesPoint } from "../home/widgets/primitives/series";
import type { Transport } from "../transport/types";
import { HealthDiscovery } from "./discovery";
import type { HealthService } from "./types";

export type HealthSeries = (key: string, statusName: string, valueKey: string) => readonly SeriesPoint[];

const NO_POINTS: readonly SeriesPoint[] = [];

/** Live list of health-publishing service instances for a connected transport, plus the
 *  temperature history the discovery keeps. */
export function useHealth(transport: Transport | null): { services: HealthService[]; series: HealthSeries } {
  const [services, setServices] = useState<HealthService[]>([]);
  const discoveryRef = useRef<HealthDiscovery | null>(null);

  useEffect(() => {
    if (!transport) return;
    const discovery = new HealthDiscovery(transport);
    discoveryRef.current = discovery;
    void discovery.start(setServices);
    return () => {
      discoveryRef.current = null;
      void discovery.stop();
      setServices([]);
    };
  }, [transport]);

  const series = useCallback<HealthSeries>(
    (key, statusName, valueKey) => discoveryRef.current?.series(key, statusName, valueKey) ?? NO_POINTS,
    [],
  );
  return { services, series };
}

/** The wall clock, re-read every `periodMs` — for views that must notice silence (nothing arrives
 *  to re-render them when a producer hangs). */
export function useNow(periodMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}
