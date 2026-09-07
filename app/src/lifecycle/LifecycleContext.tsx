import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { useLifecycle } from "./useLifecycle";
import type { LifecycleService } from "./types";

export interface LifecycleContextValue {
  /** One LifecycleDiscovery for the whole app — Home widgets and the Cameras tab share it. */
  services: LifecycleService[];
  /** Match a config reference: `<instance>` or `<vehicle>/<instance>`. */
  find: (ref: string) => LifecycleService | undefined;
}

/** The raw context — for tests and extensions that provide a value without the live provider. */
export const LifecycleCtx = createContext<LifecycleContextValue | null>(null);

export function LifecycleProvider({ children }: { children: ReactNode }) {
  const { transport } = useTransportContext();
  const services = useLifecycle(transport);
  const value = useMemo<LifecycleContextValue>(
    () => ({
      services,
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
    [services],
  );
  return <LifecycleCtx.Provider value={value}>{children}</LifecycleCtx.Provider>;
}

export function useLifecycleContext(): LifecycleContextValue {
  const v = useContext(LifecycleCtx);
  if (!v) throw new Error("useLifecycleContext must be used inside <LifecycleProvider>");
  return v;
}
