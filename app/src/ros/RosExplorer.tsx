import { useMemo, useState } from "react";
import type { Transport } from "../transport/types";
import { FlavorResolver } from "../schema/resolver";
import { useRosGraph } from "./useRosGraph";
import type { TopicEntry } from "./graph";
import { TopicInspector } from "./TopicInspector";

const mono = { fontFamily: "ui-monospace, monospace", fontSize: ".8rem" } as const;

function QosChips({ topic }: { topic: TopicEntry }) {
  const chip = (label: string, color: string) => (
    <span style={{ ...mono, fontSize: ".7rem", color, border: `1px solid ${color}`, borderRadius: 4, padding: "0 .3rem", marginLeft: ".35rem" }}>
      {label}
    </span>
  );
  return (
    <>
      {topic.bestEffort && chip("best_effort", "#b80")}
      {topic.transientLocal && chip("latched", "#27b")}
    </>
  );
}

/**
 * ROS graph explorer: topics/nodes/services reconstructed live from the rmw_zenoh liveliness tokens
 * (useRosGraph), with per-topic drill-down into a decoding inspector. The graph shows whatever the
 * bus advertises even when no data flows — same view `ros2 topic list` would give on the vehicle.
 */
export function RosExplorer({ transport }: { transport: Transport }) {
  const graph = useRosGraph(transport);
  const resolver = useMemo(() => new FlavorResolver(transport), [transport]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = graph.topics.find((t) => `${t.domainId}|${t.name}|${t.typeHash}` === selectedId) ?? null;

  return (
    <section style={{ marginTop: "2rem" }}>
      <h2 style={{ marginBottom: ".25rem" }}>
        ROS graph{" "}
        <small style={{ color: "#888", fontWeight: 400 }}>
          {graph.nodes.length} nodes · {graph.topics.length} topics · {graph.services.length} services
          {graph.domains.length > 0 && ` · domain ${graph.domains.join(", ")}`}
        </small>
      </h2>
      {graph.tokenCount === 0 ? (
        <p style={{ color: "#888" }}>
          No <code>@ros2_lv/**</code> liveliness tokens seen — is an rmw_zenoh graph routed to this bus?
        </p>
      ) : (
        <table style={{ ...mono, width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#888" }}>
              <th>topic</th>
              <th>type</th>
              <th style={{ width: 50 }}>pubs</th>
              <th style={{ width: 50 }}>subs</th>
            </tr>
          </thead>
          <tbody>
            {graph.topics.map((t) => {
              const id = `${t.domainId}|${t.name}|${t.typeHash}`;
              const isSel = id === selectedId;
              return (
                <tr
                  key={id}
                  onClick={() => setSelectedId(isSel ? null : id)}
                  style={{ borderTop: "1px solid #eee", cursor: "pointer", background: isSel ? "#eef6ff" : undefined }}
                >
                  <td style={{ padding: ".2rem 0" }}>
                    {t.name}
                    <QosChips topic={t} />
                  </td>
                  <td style={{ color: "#666" }}>{t.typeName}</td>
                  <td>{t.publishers.length}</td>
                  <td>{t.subscribers.length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {selected && <TopicInspector transport={transport} resolver={resolver} topic={selected} />}

      {graph.nodes.length > 0 && (
        <details style={{ marginTop: ".75rem" }}>
          <summary style={{ cursor: "pointer", color: "#555" }}>Nodes ({graph.nodes.length})</summary>
          <ul style={{ ...mono, columns: 2, margin: ".5rem 0" }}>
            {graph.nodes.map((n) => (
              <li key={n.keyexpr}>{n.nodeFq}</li>
            ))}
          </ul>
        </details>
      )}
      {graph.services.length > 0 && (
        <details style={{ marginTop: ".25rem" }}>
          <summary style={{ cursor: "pointer", color: "#555" }}>Services ({graph.services.length})</summary>
          <ul style={{ ...mono, margin: ".5rem 0" }}>
            {graph.services.map((s) => (
              <li key={s.name + s.typeName}>
                {s.name} <span style={{ color: "#888" }}>{s.typeName}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
