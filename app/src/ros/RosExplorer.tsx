import { useState } from "react";
import { useRosGraphContext } from "./RosGraphContext";
import type { TopicEntry } from "./graph";
import { TopicInspector } from "./TopicInspector";

function QosChips({ topic }: { topic: TopicEntry }) {
  return (
    <>
      {topic.bestEffort && <span className="chip warn">best_effort</span>}
      {topic.transientLocal && <span className="chip info">latched</span>}
    </>
  );
}

/**
 * ROS graph explorer: topics/nodes/services reconstructed live from the rmw_zenoh liveliness tokens
 * (useRosGraph), with per-topic drill-down into a decoding inspector. The graph shows whatever the
 * bus advertises even when no data flows — same view `ros2 topic list` would give on the vehicle.
 */
export function RosExplorer() {
  const { graph } = useRosGraphContext();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = graph.topics.find((t) => `${t.domainId}|${t.name}|${t.typeHash}` === selectedId) ?? null;

  return (
    <section className="card">
      <div className="card-header">
        <h2>ROS graph</h2>
        <span className="meta">
          {graph.nodes.length} nodes · {graph.topics.length} topics · {graph.services.length} services
          {graph.domains.length > 0 && ` · domain ${graph.domains.join(", ")}`}
        </span>
      </div>
      {graph.tokenCount === 0 ? (
        <p className="empty">
          No <span className="mono">@ros2_lv/**</span> liveliness tokens seen — is an rmw_zenoh graph routed to this bus?
        </p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
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
                <tr key={id} className={isSel ? "selected" : undefined} onClick={() => setSelectedId(isSel ? null : id)}>
                  <td>
                    {t.name} <QosChips topic={t} />
                  </td>
                  <td className="dim">{t.typeName}</td>
                  <td>{t.publishers.length}</td>
                  <td>{t.subscribers.length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {selected && <TopicInspector topic={selected} />}

      {graph.nodes.length > 0 && (
        <details className="panel">
          <summary>Nodes ({graph.nodes.length})</summary>
          <div className="panel-body">
            <ul className="plain" style={{ columns: 2 }}>
              {graph.nodes.map((n) => (
                <li key={n.keyexpr}>{n.nodeFq}</li>
              ))}
            </ul>
          </div>
        </details>
      )}
      {graph.services.length > 0 && (
        <details className="panel">
          <summary>Services ({graph.services.length})</summary>
          <div className="panel-body">
            <ul className="plain">
              {graph.services.map((s) => (
                <li key={s.name + s.typeName}>
                  {s.name} <span className="dim">{s.typeName}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </section>
  );
}
