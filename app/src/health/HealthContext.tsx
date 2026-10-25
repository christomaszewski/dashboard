import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { useHealth, type HealthSeries } from "./useHealth";
import { useVehicleHealth } from "./useVehicleHealth";
import { useVehicleState } from "../vstate/VehicleStateContext";
import { useConfig } from "../config/ConfigContext";
import type { HealthService } from "./types";
import type { HealthEvent } from "./discovery";

export interface HealthContextValue {
  events?: readonly HealthEvent[];
  errors?: readonly string[];
  /** One HealthDiscovery for the whole app — Home widgets and the Cameras tab share it. */
  services: HealthService[];
  /** Match a config reference: `<instance>` or `<vehicle>/<instance>`. */
  find: (ref: string) => HealthService | undefined;
  /** Recent history of one `temp.<where>_c` value (see HealthDiscovery.series). */
  series: HealthSeries;
}

/** The raw context — for tests and extensions that provide a value without the live provider. */
export const HealthCtx = createContext<HealthContextValue | null>(null);

export function HealthProvider({ children }: { children: ReactNode }) {
  const { transport } = useTransportContext();
  const vehicle = useVehicleState();
  const config = useConfig();
  const options = config.phase === "ready" ? config.config.health : undefined;
  // With vehicle state the vehicle runs the discovery and every /diagnostics subscription; this
  // page gets the assembled services as changes (docs/VEHICLE_STATE.md, "Health").
  const direct = useHealth(vehicle.enabled ? null : transport);
  const fromVehicle = useVehicleHealth(vehicle.enabled ? vehicle.client : null, options, vehicle.error);
  const { services, series, events, errors } = vehicle.enabled ? fromVehicle : direct;
  const value = useMemo<HealthContextValue>(
    () => ({
      services,
      series,
      events,
      errors,
      find: (ref) => {
        const slash = ref.indexOf("/");
        if (slash > 0) {
          const vehicleId = ref.slice(0, slash);
          const instance = ref.slice(slash + 1);
          return services.find((s) => s.vehicleId === vehicleId && s.instance === instance);
        }
        return services.find((s) => s.instance === ref);
      },
    }),
    [services, series, events, errors],
  );
  return <HealthCtx.Provider value={value}>{children}</HealthCtx.Provider>;
}

export function useHealthContext(): HealthContextValue {
  const v = useContext(HealthCtx);
  if (!v) throw new Error("useHealthContext must be used inside <HealthProvider>");
  return v;
}
