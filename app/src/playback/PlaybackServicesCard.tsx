import { usePlaybackContext } from "./PlaybackContext";
import { PlaybackCard } from "./PlaybackCard";

/**
 * Zero-config surface for every playback-controllable source on the bus. Lives on the Cameras
 * tab beside the recorder cards; renders nothing until a producer advertises playback — a live
 * camera never does, so a real vehicle never sees this card.
 */
export function PlaybackServicesCard() {
  const { services } = usePlaybackContext();
  if (services.length === 0) return null;
  const playing = services.filter((s) => s.descriptor.state === "playing").length;
  return (
    <section className="card">
      <div className="card-header">
        <h2>Playback control</h2>
        <span className="meta">
          {services.length} source{services.length === 1 ? "" : "s"} · {playing} playing
        </span>
      </div>
      <div className="card-body lifecycle-grid">
        {services.map((s) => (
          <PlaybackCard key={s.key} service={s} />
        ))}
      </div>
    </section>
  );
}
