import { useHealthContext } from "./HealthContext";
import { HealthInstance } from "./HealthInstance";
import { healthVerdict } from "./types";
import { useNow } from "./useHealth";

/**
 * Zero-config surface for every service instance publishing health (camera-service today): lives on
 * the Cameras tab beside the recording control, because a camera's health <instance> is its stream
 * instance. Every status with all its values — the Home `health` widget is the curated view.
 * Renders nothing until an instance advertises.
 */
export function HealthServicesCard() {
  const { services } = useHealthContext();
  const nowMs = useNow();
  if (services.length === 0) return null;
  const notOk = services.filter((s) => healthVerdict(s, s.snapshot.status, nowMs).level !== "ok").length;
  return (
    <section className="card">
      <div className="card-header">
        <h2>Health</h2>
        <span className="meta">
          {services.length} service{services.length === 1 ? "" : "s"} · {notOk === 0 ? "all OK" : `${notOk} not OK`}
        </span>
      </div>
      <div className="card-body health-grid">
        {services.map((s) => (
          <div key={s.key} className="widget-card">
            <HealthInstance service={s} options={{ details: true }} nowMs={nowMs} />
          </div>
        ))}
      </div>
    </section>
  );
}
