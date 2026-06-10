import type { Transport } from "../transport/types";
import { useStreams } from "./useStreams";
import { StreamTile } from "./StreamTile";

export function StreamGrid({ transport }: { transport: Transport }) {
  const streams = useStreams(transport);
  const live = streams.filter((s) => s.alive).length;
  return (
    <section className="card">
      <div className="card-header">
        <h2>Camera streams</h2>
        <span className="meta">
          {streams.length} discovered{live !== streams.length ? ` · ${live} live` : ""}
        </span>
      </div>
      {streams.length === 0 ? (
        <p className="empty">
          No live streams advertised on <span className="mono">fleet/*/media/*</span>.
        </p>
      ) : (
        <div className="tile-grid">
          {streams.map((s) => (
            <StreamTile key={s.key} stream={s} />
          ))}
        </div>
      )}
    </section>
  );
}
