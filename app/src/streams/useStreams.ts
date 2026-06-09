import { useEffect, useState } from "react";
import type { Transport } from "../transport/types";
import { StreamDiscovery } from "./discovery";
import type { DiscoveredStream } from "./types";

/** Live list of discovered media streams for a connected transport. */
export function useStreams(transport: Transport | null): DiscoveredStream[] {
  const [streams, setStreams] = useState<DiscoveredStream[]>([]);

  useEffect(() => {
    if (!transport) return;
    const discovery = new StreamDiscovery(transport);
    void discovery.start(setStreams);
    return () => {
      void discovery.stop();
      setStreams([]);
    };
  }, [transport]);

  return streams;
}
