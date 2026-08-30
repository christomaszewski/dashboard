import { useTransportContext } from "../transport/TransportContext";
import { useStreamsContext } from "../streams/StreamsContext";
import { useRosGraphContext } from "../ros/RosGraphContext";
import type { TabId } from "../shell/useHashRoute";

/** Built-in Home when the instance config has no `home:` block (or none is mounted at all). */
export function DefaultHome({ navigate }: { navigate: (tab: TabId) => void }) {
  const { status, locator } = useTransportContext();
  const { streams } = useStreamsContext();
  const { graph } = useRosGraphContext();
  const liveStreams = streams.filter((s) => s.alive).length;

  return (
    <>
      <section className="card">
        <div className="card-header">
          <h2>Vehicle</h2>
          <span className={`pill ${status === "connected" ? "ok" : status === "error" ? "err" : "warn"}`}>{status}</span>
        </div>
        <div className="card-body">
          <p className="dim">
            zenoh <span className="mono">{locator}</span>
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Cameras</h2>
          <span className="meta">
            {streams.length} discovered · {liveStreams} live
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => navigate("cameras")}>
            Open console →
          </button>
        </div>
        {streams.length > 0 && (
          <div className="card-body">
            <p className="dim mono">{streams.map((s) => s.descriptor.role || s.descriptor.id).join(" · ")}</p>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h2>ROS graph</h2>
          <span className="meta">
            {graph.nodes.length} nodes · {graph.topics.length} topics · {graph.services.length} services
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => navigate("ros")}>
            Explore →
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-body">
          <p className="dim">
            This is the built-in Home. To lay out project-specific status pills, service buttons, video streams, and
            topic readouts here, add a <span className="mono">home:</span> block to this instance&apos;s config YAML —
            see <span className="mono">config/infra/dashboard.example.yaml</span>.
          </p>
        </div>
      </section>
    </>
  );
}
