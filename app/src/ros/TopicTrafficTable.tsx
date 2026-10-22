import { useEffect, useState } from "react";
import type { LivelinessEntity, TopicEntry } from "./graph";
import { publisherGid } from "./publisherGid";
import type { TopicTrafficSnapshot, TrafficStats } from "./topicTraffic";

export function EndpointNames({ endpoints }: { endpoints: LivelinessEntity[] }) {
  if (!endpoints.length) return <span className="dim">—</span>;
  return <ul className="plain ros-endpoints">{endpoints.map((e) =>
    <li key={e.keyexpr} title={`Domain ${e.domainId} · session ${e.zid} · node ${e.nid} · endpoint ${e.eid}`}>
      {e.nodeFq}
    </li>)}</ul>;
}

function bandwidth(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB/s`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB/s`;
  return `${bytes.toFixed(0)} B/s`;
}

function Cells({ stats }: { stats?: TrafficStats }) {
  return <><td>{(stats?.count ?? 0).toLocaleString()}</td><td>{(stats?.hz ?? 0).toFixed(1)}</td>
    <td>{bandwidth(stats?.bytesPerSecond ?? 0)}</td></>;
}

export function TopicTrafficTable({ topic, traffic }: { topic: TopicEntry; traffic?: TopicTrafficSnapshot }) {
  const [gids, setGids] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  const signature = JSON.stringify(topic.publishers.map((p) => p.keyexpr));
  useEffect(() => {
    let active = true;
    setError(false);
    Promise.all((JSON.parse(signature) as string[]).map(async (key) => [key, await publisherGid(key)]))
      .then((entries) => { if (active) setGids(Object.fromEntries(entries)); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [signature]);
  const known = new Set(topic.publishers.map((p) => gids[p.keyexpr]));
  const unmatched = traffic?.publishers.filter((p) => !known.has(p.id)) ?? [];

  return <div className="ros-traffic">
    <h3>Publisher traffic <span className="dim">· received by this dashboard</span></h3>
    <div className="ros-table-scroll"><table className="data-table ros-endpoint-table">
      <thead><tr><th>Publisher node</th><th>Messages</th><th>Hz</th><th>Payload bandwidth</th></tr></thead>
      <tbody>
        <tr><td>All publishers</td><Cells stats={traffic} /></tr>
        {topic.publishers.map((p) => <tr key={p.keyexpr}>
          <td><EndpointNames endpoints={[p]} /><small className="dim">endpoint {p.eid} · session {p.zid.slice(0, 8)}</small></td>
          <Cells stats={traffic?.publishers.find((row) => row.id === gids[p.keyexpr])} />
        </tr>)}
        {unmatched.map((row) => <tr key={row.id}><td title={row.id}>
          {row.id === "unattributed" ? "Unknown publisher (no readable ID)" : row.id === "overflow"
            ? "Other publishers (tracking limit reached)" : `Unmatched publisher ${row.id.slice(0, 12)}…`}
        </td><Cells stats={row} /></tr>)}
      </tbody>
    </table></div>
    <p className="dim ros-traffic-note">Counts start when the shared topic subscription opens. Rates use the last 5 seconds
      (100 ms buckets; shorter during startup). Payload bytes exclude network overhead. Delivery loss or filtering
      can make these lower than the publisher’s output; cache-query replies are excluded.</p>
    {unmatched.length > 0 && <p className="dim ros-traffic-note">Unmatched traffic has no current graph endpoint or a missing/unsupported publisher ID.</p>}
    {error && <p className="error-box">Publisher ID matching is unavailable; received traffic remains listed separately.</p>}
  </div>;
}
