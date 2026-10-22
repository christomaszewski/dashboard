import { memo, useState } from "react";
import { useRosGraphContext } from "./RosGraphContext";
import type { RosGraph, TopicEntry } from "./graph";
import { TopicInspector } from "./TopicInspector";
import { EndpointNames } from "./TopicTrafficTable";

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
export function RosExplorer({ active = true }: { active?: boolean }) {
  const { graph } = useRosGraphContext();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = selectedId === null ? null : graph.topics.find((t) => t.dataKeyexpr === selectedId) ?? null;

  return (
    <section className="card">
      <GraphTopics active={active} graph={graph} selectedId={selectedId} selectTopic={setSelectedId} />
      {/* Keep the inspector on the live graph: hiding the tables must not change subscriptions. */}
      {selected && <TopicInspector key={selected.dataKeyexpr} topic={selected} />}
      <GraphDetails active={active} graph={graph} />
    </section>
  );
}

interface GraphViewProps { active: boolean; graph: RosGraph }
interface GraphTopicsProps extends GraphViewProps {
  selectedId: string | null;
  selectTopic: (id: string | null) => void;
}

// Keep these tables stateless and free of context subscriptions so updates stop at the memo boundary.
// Initially hidden tables stay empty; after a visit their DOM (including open details) is retained.
// Returning to ROS renders the latest graph. No render-time refs or duplicate graph state needed.
const GraphTopics = memo(function GraphTopics({ active, graph, selectedId, selectTopic }: GraphTopicsProps) {
  if (!active) return null;
  return (
    <>
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
        <div className="ros-table-scroll"><table className="data-table">
          <thead>
            <tr>
              <th>topic</th>
              <th>type</th>
              <th>domain</th>
              <th>Publisher nodes</th>
              <th>Subscriber nodes</th>
            </tr>
          </thead>
          <tbody>
            {graph.topics.map((t) => {
              const id = t.dataKeyexpr;
              const isSel = id === selectedId;
              return (
                <tr key={id} className={isSel ? "selected" : undefined} onClick={() => selectTopic(isSel ? null : id)}>
                  <td>
                    <button className="ros-topic-button" aria-expanded={isSel} onClick={(e) => {
                      e.stopPropagation(); selectTopic(isSel ? null : id);
                    }}>{t.name}</button> <QosChips topic={t} />
                  </td>
                  <td className="dim">{t.typeName}</td>
                  <td>{t.domainId}</td>
                  <td><EndpointNames endpoints={t.publishers} /></td>
                  <td><EndpointNames endpoints={t.subscribers} /></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      {graph.topics.length > 0 && <p className="dim ros-traffic-note">Select a topic to inspect messages and measure each publisher’s traffic.</p>}
    </>
  );
}, (previous, next) => !next.active || (previous.active === next.active && previous.graph === next.graph &&
  previous.selectedId === next.selectedId && previous.selectTopic === next.selectTopic));

const GraphDetails = memo(function GraphDetails({ active, graph }: GraphViewProps) {
  if (!active) return null;
  return (
    <>
      {graph.nodes.length > 0 && (
        <details className="panel">
          <summary>Nodes ({graph.nodes.length})</summary>
          <div className="panel-body">
            <ul className="plain" style={{ columns: 2 }}>
              {graph.nodes.map((n) => (
                <li key={n.keyexpr} title={`Session ${n.zid} · node ${n.nid}`}>{n.nodeFq} <span className="dim">· domain {n.domainId}</span></li>
              ))}
            </ul>
          </div>
        </details>
      )}
      {graph.services.length > 0 && (
        <details className="panel">
          <summary>Services ({graph.services.length})</summary>
          <div className="panel-body">
            <div className="ros-table-scroll"><table className="data-table ros-endpoint-table">
              <thead><tr><th>Service</th><th>Type</th><th>Domain</th><th>Server nodes</th><th>Client nodes</th></tr></thead>
              <tbody>{graph.services.map((s) => {
                const domain = (s.servers[0] ?? s.clients[0]).domainId;
                return <tr key={`${domain}|${s.name}|${s.typeName}`}>
                  <td>{s.name}</td><td className="dim">{s.typeName}</td><td>{domain}</td>
                  <td><EndpointNames endpoints={s.servers} /></td><td><EndpointNames endpoints={s.clients} /></td>
                </tr>;
              })}</tbody>
            </table></div>
          </div>
        </details>
      )}
    </>
  );
}, (previous, next) => !next.active || (previous.active === next.active && previous.graph === next.graph));
