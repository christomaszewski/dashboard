import { useCallback, useEffect, useRef, useState } from "react";
import type { SeriesPoint } from "../home/widgets/primitives/series";
import type { Transport } from "../transport/types";
import { HealthDiscovery, type HealthEvent } from "./discovery";
import { useRosGraphContext } from "../ros/RosGraphContext";
import { RosHealthSource } from "./rosSource";
import { useConfig } from "../config/ConfigContext";
import type { HealthService } from "./types";

export type HealthSeries = (key: string, statusName: string, valueKey: string) => readonly SeriesPoint[];

const NO_POINTS: readonly SeriesPoint[] = [];

/** Live list of health-publishing service instances for a connected transport, plus the
 *  temperature history the discovery keeps. */
export function useHealth(transport: Transport | null): { services: HealthService[]; series: HealthSeries; events: readonly HealthEvent[]; errors: string[] } {
  const [services, setServices] = useState<HealthService[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { graph, resolver } = useRosGraphContext();
  const config = useConfig();
  const options = config.phase === "ready" ? config.config.health : undefined;
  const topics = useRef(graph.topics);
  topics.current = graph.topics;
  const rosRef = useRef<RosHealthSource | null>(null);
  const discoveryRef = useRef<HealthDiscovery | null>(null);

  useEffect(() => {
    if (!transport) return;
    const discovery = new HealthDiscovery(transport);
    discoveryRef.current = discovery;
    let active = true;
    const onError = (key: string, error?: string) => {
      if (!active) return;
      setErrors((old) => {
        if (old[key] === error) return old;
        const next = { ...old };
        if (error) next[key] = error; else delete next[key];
        return next;
      });
    };
    void discovery.start(setServices).catch((e) => onError("native", String(e)));
    const ros = resolver ? new RosHealthSource(transport, resolver, discovery, onError, options) : null;
    rosRef.current = ros;
    ros?.update(topics.current);
    const retry = setInterval(() => ros?.update(topics.current), 5000);
    return () => {
      active = false;
      clearInterval(retry);
      ros?.close();
      rosRef.current = null;
      discoveryRef.current = null;
      void discovery.stop();
      setServices([]);
    };
  }, [transport, resolver, options]);
  useEffect(() => rosRef.current?.update(graph.topics), [graph.topics]);

  const series = useCallback<HealthSeries>(
    (key, statusName, valueKey) => discoveryRef.current?.series(key, statusName, valueKey) ?? NO_POINTS,
    [],
  );
  return { services, series, events: discoveryRef.current?.events ?? [], errors: Object.values(errors) };
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
