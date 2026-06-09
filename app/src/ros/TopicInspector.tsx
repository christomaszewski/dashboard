import { useEffect, useRef, useState } from "react";
import type { Subscription, Transport } from "../transport/types";
import type { DecodedMessage, SchemaResolver } from "../schema/types";
import type { TopicEntry } from "./graph";
import { MessageTree } from "./MessageTree";

const FLUSH_MS = 200; // decode + render the latest sample at 5 Hz, however fast the topic publishes
const HZ_WINDOW_MS = 5000;

interface InspectorState {
  message?: DecodedMessage;
  error?: string;
  warning?: string;
  hz?: number;
  lastBytes?: number;
  latched?: boolean; // message came from the transient-local get, not a live sample
}

/**
 * Live view of one ROS topic: subscribes to its rmw_zenoh data keyexpr, decodes the latest sample on
 * a throttle, and renders it as a tree with rate/size stats. Transient-local topics are additionally
 * `get`-queried once on open — rmw_zenoh backs latched publishers with a queryable, so the last
 * value shows even if nothing publishes while we watch.
 */
export function TopicInspector({ transport, resolver, topic }: { transport: Transport; resolver: SchemaResolver; topic: TopicEntry }) {
  const [state, setState] = useState<InspectorState>({});

  // Refs, not state: samples can arrive at hundreds of Hz; React sees them only at flush time.
  const latest = useRef<{ payload: Uint8Array; latched: boolean } | null>(null);
  const arrivals = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    let sub: Subscription | null = null;
    let timer: number | null = null;
    latest.current = null;
    arrivals.current = [];
    setState({});

    const identity = { flavor: "ros2" as const, typeName: topic.typeName, rihsHash: topic.typeHash };

    resolver
      .resolve(identity)
      .then(async (decoder) => {
        if (cancelled) return;

        const flush = () => {
          const sample = latest.current;
          if (!sample) return;
          latest.current = null;
          const now = performance.now();
          const inWindow = arrivals.current.filter((t) => now - t <= HZ_WINDOW_MS);
          arrivals.current = inWindow;
          const hz =
            inWindow.length > 1 ? ((inWindow.length - 1) / (now - inWindow[0])) * 1000 : undefined;
          try {
            const message = decoder.decode(sample.payload);
            setState({ message, warning: decoder.lastWarning?.(), hz, lastBytes: sample.payload.length, latched: sample.latched });
          } catch (e) {
            setState({ error: `decode failed: ${e instanceof Error ? e.message : String(e)}`, hz, lastBytes: sample.payload.length });
          }
        };

        sub = await transport.subscribe(topic.dataKeyexpr, (s) => {
          if (s.kind !== "put") return;
          latest.current = { payload: s.payload, latched: false };
          arrivals.current.push(performance.now());
          if (arrivals.current.length > 256) arrivals.current.splice(0, 128);
        });
        if (cancelled) {
          void sub.close();
          sub = null;
          return;
        }
        timer = window.setInterval(flush, FLUSH_MS);

        if (topic.transientLocal) {
          const replies = await transport.get(topic.dataKeyexpr);
          // Only seed from the latched value if no live sample beat it here.
          if (!cancelled && replies.length > 0 && latest.current === null && arrivals.current.length === 0) {
            latest.current = { payload: replies[0].payload, latched: true };
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setState({ error: `no decoder: ${e instanceof Error ? e.message : String(e)}` });
      });

    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
      void sub?.close();
    };
    // Graph rebuilds mint new TopicEntry objects for the same topic; resubscribe only when the
    // subscription-relevant fields actually change (dataKeyexpr embeds name+type+hash).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, resolver, topic.dataKeyexpr, topic.transientLocal]);

  const mono = { fontFamily: "ui-monospace, monospace", fontSize: ".8rem" } as const;

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: ".75rem 1rem", marginTop: ".75rem", background: "#fcfcfc" }}>
      <div style={{ display: "flex", gap: "1rem", alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={mono}>{topic.name}</strong>
        <span style={{ ...mono, color: "#888" }}>{topic.typeName}</span>
        <span style={{ ...mono, color: "#888" }} title={topic.typeHash}>
          {topic.typeHash.slice(0, 14)}…
        </span>
        <span style={{ ...mono, color: "#2a7" }}>
          {state.hz !== undefined
            ? `${state.hz.toFixed(1)} Hz`
            : state.message || state.lastBytes !== undefined
              ? state.latched
                ? "latched"
                : "live"
              : "no data yet"}
          {state.lastBytes !== undefined ? ` · ${state.lastBytes} B` : ""}
        </span>
      </div>
      {state.error && (
        <pre style={{ color: "#c33", whiteSpace: "pre-wrap", background: "#fee", padding: ".5rem", borderRadius: 4 }}>{state.error}</pre>
      )}
      {state.warning && <p style={{ color: "#b80", margin: ".4rem 0" }}>⚠ {state.warning}</p>}
      {state.message && (
        <div style={{ marginTop: ".5rem", maxHeight: 420, overflow: "auto" }}>
          <MessageTree message={state.message} />
        </div>
      )}
    </div>
  );
}
