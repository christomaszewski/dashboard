import type { Transport } from "../transport/types";
import { useStreams } from "./useStreams";
import { StreamTile } from "./StreamTile";

export function StreamGrid({ transport }: { transport: Transport }) {
  const streams = useStreams(transport);
  return (
    <section>
      <h2>
        Camera streams <small style={{ color: "#888", fontWeight: 400 }}>({streams.length} discovered)</small>
      </h2>
      {streams.length === 0 && (
        <p style={{ color: "#888" }}>
          No live streams advertised on <code>fleet/*/media/*</code>.
        </p>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
        {streams.map((s) => (
          <StreamTile key={s.key} stream={s} />
        ))}
      </div>
    </section>
  );
}
