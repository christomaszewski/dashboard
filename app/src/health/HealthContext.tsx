import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { useHealth, type HealthSeries } from "./useHealth";
import type { HealthService } from "./types";

export interface HealthContextValue {
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
  const { services, series } = useHealth(transport);
  const value = useMemo<HealthContextValue>(
    () => ({
      services,
      series,
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
    [services, series],
  );
  return <HealthCtx.Provider value={value}>{children}</HealthCtx.Provider>;
}

export function useHealthContext(): HealthContextValue {
  const v = useContext(HealthCtx);
  if (!v) throw new Error("useHealthContext must be used inside <HealthProvider>");
  return v;
}
