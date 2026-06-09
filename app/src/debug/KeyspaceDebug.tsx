import { useEffect, useRef, useState } from "react";
import type { Subscription, Transport } from "../transport/types";

/**
 * Raw bus inspector for bring-up/testing: a liveliness subscriber on `**` (the rmw_zenoh graph +
 * discovery tokens) plus an opt-in data subscription aggregated by key. Confirms the dashboard sees the
 * bus, and surfaces the real rmw_zenoh keyexprs we need to finish `parseRos2Key` + the ROS decode.
 * Seed of the eventual Zenoh Explorer panel.
 */
export function KeyspaceDebug({ transport }: { transport: Transport }) {
  const [live, setLive] = useState<string[]>([]);
  const [rows, setRows] = useState<{ key: string; count: number; bytes: number }[]>([]);
  const [pattern, setPattern] = useState("**");
  const [subbing, setSubbing] = useState(false);
  const dataSub = useRef<Subscription | null>(null);
  const acc = useRef(new Map<string, { count: number; bytes: number }>());
  const flushTimer = useRef<number | null>(null);

  // Liveliness on `**` — always on; low-rate presence (PUT/DELETE).
  useEffect(() => {
    let cancelled = false;
    let sub: Subscription | null = null;
    const set = new Set<string>();
    transport.liveliness
      .subscribe("**", (e) => {
        if (e.alive) set.add(e.keyexpr);
        else set.delete(e.keyexpr);
        setLive([...set].sort());
      })
      .then((s) => {
        if (cancelled) void s.close();
        else sub = s;
      });
    return () => {
      cancelled = true;
      void sub?.close();
    };
  }, [transport]);

  const flush = () =>
    setRows(
      [...acc.current.entries()]
        .map(([key, v]) => ({ key, count: v.count, bytes: v.bytes }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );

  const start = async () => {
    if (subbing) return;
    acc.current.clear();
    setRows([]);
    setSubbing(true);
    dataSub.current = await transport.subscribe(pattern, (s) => {
      const prev = acc.current.get(s.keyexpr) ?? { count: 0, bytes: 0 };
      acc.current.set(s.keyexpr, { count: prev.count + 1, bytes: s.payload.length });
    });
    flushTimer.current = window.setInterval(flush, 500); // throttle re-renders; `**` can be a firehose
  };

  const stop = () => {
    if (flushTimer.current !== null) {
      clearInterval(flushTimer.current);
      flushTimer.current = null;
    }
    void dataSub.current?.close();
    dataSub.current = null;
    setSubbing(false);
    flush();
  };

  useEffect(
    () => () => {
      if (flushTimer.current !== null) clearInterval(flushTimer.current);
      void dataSub.current?.close();
    },
    [],
  );

  const mono = { fontFamily: "ui-monospace, monospace", fontSize: ".8rem" } as const;

  return (
    <details style={{ marginTop: "2rem", borderTop: "1px solid #eee", paddingTop: "1rem" }}>
      <summary style={{ cursor: "pointer", color: "#555" }}>Bus debug (raw keyspace)</summary>

      <h3>
        Liveliness <small style={{ color: "#888", fontWeight: 400 }}>({live.length} on <code>**</code>)</small>
      </h3>
      <ul style={{ ...mono, maxHeight: 220, overflow: "auto", background: "#fafafa", padding: ".5rem 1.5rem" }}>
        {live.map((k) => (
          <li key={k}>{k}</li>
        ))}
      </ul>

      <h3>Data subscription</h3>
      <div style={{ display: "flex", gap: ".5rem", alignItems: "center" }}>
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          disabled={subbing}
          style={{ ...mono, flex: 1, padding: ".3rem" }}
          placeholder="keyexpr, e.g. ** or @/**"
        />
        <button onClick={subbing ? stop : () => void start()}>{subbing ? "Stop" : "Subscribe"}</button>
      </div>
      <table style={{ ...mono, width: "100%", marginTop: ".5rem", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#888" }}>
            <th>key</th>
            <th style={{ width: 70 }}>count</th>
            <th style={{ width: 90 }}>last bytes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} style={{ borderTop: "1px solid #eee" }}>
              <td>{r.key}</td>
              <td>{r.count}</td>
              <td>{r.bytes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
