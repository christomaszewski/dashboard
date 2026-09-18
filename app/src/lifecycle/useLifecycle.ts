import { useEffect, useState } from "react";
import type { Transport } from "../transport/types";
import { LifecycleDiscovery } from "./discovery";
import type { LifecycleService } from "./types";

/** Live list of lifecycle-controlled services for a connected transport. */
export function useLifecycle(transport: Transport | null): LifecycleService[] {
  const [services, setServices] = useState<LifecycleService[]>([]);

  useEffect(() => {
    if (!transport) return;
    const discovery = new LifecycleDiscovery(transport);
    void discovery.start(setServices);
    return () => {
      void discovery.stop();
      setServices([]);
    };
  }, [transport]);

  return services;
}
