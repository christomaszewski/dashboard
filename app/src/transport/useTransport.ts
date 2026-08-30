import { useEffect, useState } from "react";
import { ZenohRemoteApiTransport } from "./zenohRemoteApi";
import type { Transport } from "./types";

export type TransportStatus = "connecting" | "connected" | "error";

/** Opens one ZenohRemoteApiTransport for the locator's lifetime; closes it on unmount/change. */
export function useTransport(locator: string): { transport: Transport | null; status: TransportStatus; error: string } {
  const [transport, setTransport] = useState<Transport | null>(null);
  const [status, setStatus] = useState<TransportStatus>("connecting");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let opened: Transport | null = null;
    setTransport(null);
    setStatus("connecting");
    setError("");
    ZenohRemoteApiTransport.open(locator)
      .then((t) => {
        if (cancelled) return void t.close();
        opened = t;
        setTransport(t);
        setStatus("connected");
      })
      .catch((e) => {
        if (!cancelled) {
          setStatus("error");
          setError(String(e));
        }
      });
    return () => {
      cancelled = true;
      void opened?.close();
    };
  }, [locator]);

  return { transport, status, error };
}
