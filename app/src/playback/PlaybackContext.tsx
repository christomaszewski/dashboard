import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { usePlayback } from "./usePlayback";
import type { PlaybackService } from "./types";

export interface PlaybackContextValue {
  /** One PlaybackDiscovery for the whole app — Home tiles and the Cameras tab share it. */
  services: PlaybackService[];
  /** Match `<instance>` or `<vehicle>/<instance>` — the same segments the media key uses. */
  find: (ref: string) => PlaybackService | undefined;
}

/** The raw context — for tests and extensions that provide a value without the live provider. */
export const PlaybackCtx = createContext<PlaybackContextValue | null>(null);

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const { transport } = useTransportContext();
  const services = usePlayback(transport);
  const value = useMemo<PlaybackContextValue>(
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
  return <PlaybackCtx.Provider value={value}>{children}</PlaybackCtx.Provider>;
}

export function usePlaybackContext(): PlaybackContextValue {
  const v = useContext(PlaybackCtx);
  if (!v) throw new Error("usePlaybackContext must be used inside <PlaybackProvider>");
  return v;
}
