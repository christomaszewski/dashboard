import { useLifecycleContext } from "./LifecycleContext";
import { LifecycleCard } from "./LifecycleCard";

/**
 * Zero-config surface for every lifecycle-controlled service on the bus (camera-service recorders
 * today): lives on the Cameras tab because a recorder's <instance> is the camera's stream instance.
 * Renders nothing until a service advertises — no control plane, no card.
 */
export function LifecycleServicesCard() {
  const { services } = useLifecycleContext();
  if (services.length === 0) return null;
  const active = services.filter((s) => s.descriptor.state === "active").length;
  return (
    <section className="card">
      <div className="card-header">
        <h2>Recording control</h2>
        <span className="meta">
          {services.length} service{services.length === 1 ? "" : "s"} · {active} active
        </span>
      </div>
      <div className="card-body lifecycle-grid">
        {services.map((s) => (
          <LifecycleCard key={s.key} service={s} />
        ))}
      </div>
    </section>
  );
}
