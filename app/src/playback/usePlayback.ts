import { useEffect, useState } from "react";
import type { Transport } from "../transport/types";
import { PlaybackDiscovery } from "./discovery";
import type { PlaybackService } from "./types";

/** Live list of playback-controllable services for a connected transport. */
export function usePlayback(transport: Transport | null): PlaybackService[] {
  const [services, setServices] = useState<PlaybackService[]>([]);
  useEffect(() => {
    if (!transport) return;
    const discovery = new PlaybackDiscovery(transport);
    void discovery.start(setServices);
    return () => {
      void discovery.stop();
      setServices([]);
    };
  }, [transport]);
  return services;
}
