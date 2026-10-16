import type { TopicEntry } from "../ros/graph";
import { topicStreams } from "../ros/topicStreamPool";
import type { SchemaResolver } from "../schema/types";
import type { Subscription, Transport } from "../transport/types";
import type { HealthDiscovery } from "./discovery";
import type { HealthOptions } from "./config";

/** Raw per-message subscription; /diagnostics may have many simultaneous publishers. */
export class RosHealthSource {
  private entries = new Map<string, { closed: boolean; sub?: Subscription }>();
  constructor(private transport: Transport, private resolver: SchemaResolver,
    private store: HealthDiscovery, private onError: (key: string, error?: string) => void,
    private options: HealthOptions = {}) {}

  update(topics: readonly TopicEntry[]) {
    const wanted = topics.filter((t) => t.typeName === "diagnostic_msgs/msg/DiagnosticArray" &&
      t.publishers.length > 0 && (this.options.ros_topics ? this.options.ros_topics.includes(t.name) : !t.name.endsWith("/diagnostics_agg")) &&
      (!this.options.ros_domains || this.options.ros_domains.includes(t.domainId)));
    for (const [key, entry] of this.entries) if (!wanted.some((t) => t.dataKeyexpr === key)) {
      entry.closed = true;
      void entry.sub?.close();
      this.entries.delete(key);
      this.onError(key);
    }
    for (const topic of wanted) {
      const key = topic.dataKeyexpr;
      if (this.entries.has(key)) continue;
      const entry: { closed: boolean; sub?: Subscription } = { closed: false };
      this.entries.set(key, entry);
      void (async () => {
        try {
          const decoder = await this.resolver.resolve({ flavor: "ros2", typeName: topic.typeName, rihsHash: topic.typeHash });
          if (entry.closed) return;
          const sub = await topicStreams(this.transport).subscribe(key, (sample) => {
            if (entry.closed || sample.kind !== "put") return;
            try {
              const message = decoder.decode(sample.payload);
              if (decoder.lastWarning?.()) throw new Error(decoder.lastWarning());
              this.store.ingestRos(topic, message, (this.options.ros_stale_after_s ?? 15) * 1000);
              this.onError(key);
            } catch (error) { this.onError(key, `${topic.name}: ${String(error)}`); }
          }, topic);
          if (entry.closed) await sub.close();
          else entry.sub = sub;
        } catch (error) {
          if (!entry.closed) {
            this.entries.delete(key); // the next update retries
            this.onError(key, `${topic.name}: ${String(error)}`);
          }
        }
      })();
    }
  }

  close() {
    for (const entry of this.entries.values()) { entry.closed = true; void entry.sub?.close(); }
    this.entries.clear();
  }
}
