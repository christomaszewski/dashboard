// The vehicle's health services for vehicle state (docs/VEHICLE_STATE.md, "Health"): the same
// HealthDiscovery and /diagnostics ingestion the browser runs, here next to the ROS graph, so pages
// get assembled services instead of every DiagnosticArray from every publisher. Runs only while
// some page watches health.
import { HealthDiscovery } from "../health/discovery";
import { RosHealthSource } from "../health/rosSource";
import type { HealthService } from "../health/types";
import type { RosGraph, TopicEntry } from "../ros/graph";
import type { SchemaResolver } from "../schema/types";
import type { Transport } from "../transport/types";
import type { HealthSource } from "./server";

export class HealthHub implements HealthSource {
  private refs = 0;
  private discovery: HealthDiscovery | null = null;
  private ros: RosHealthSource | null = null;
  private retry: ReturnType<typeof setInterval> | null = null;
  private services: HealthService[] = [];
  private topics: TopicEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly transport: Transport,
    private readonly resolver: SchemaResolver,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  retain(): void {
    if (this.refs++ === 0) this.start();
  }

  release(): void {
    if (--this.refs === 0) this.stop();
  }

  setGraph(graph: RosGraph): void {
    this.topics = graph.topics;
    this.ros?.update(this.topics);
  }

  list(): readonly HealthService[] {
    return this.services;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private start(): void {
    const discovery = new HealthDiscovery(this.transport);
    this.discovery = discovery;
    void discovery.start((services) => {
      if (this.discovery !== discovery) return;
      this.services = services;
      for (const cb of [...this.listeners]) cb();
    }).catch((e) => this.log(`health: ${String(e)}`));
    this.ros = new RosHealthSource(this.transport, this.resolver, discovery, (key, error) => {
      if ((this.errors.get(key) ?? "") === (error ?? "")) return;
      if (error) this.errors.set(key, error); else this.errors.delete(key);
      this.log(error ? `health: ${error}` : `health: ${key} recovered`);
    });
    this.ros.update(this.topics);
    this.retry = setInterval(() => this.ros?.update(this.topics), 5000);
  }

  private stop(): void {
    if (this.retry !== null) clearInterval(this.retry);
    this.retry = null;
    this.ros?.close();
    this.ros = null;
    void this.discovery?.stop();
    this.discovery = null;
    this.services = [];
    for (const cb of [...this.listeners]) cb();
  }
}
