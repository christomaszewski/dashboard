import { useEffect, useState } from "react";
import { ReconnectingTransport, type LinkStatus } from "./reconnecting";
import { ZenohRemoteApiTransport } from "./zenohRemoteApi";
import type { Transport } from "./types";

export type TransportStatus = LinkStatus;

/**
 * One transport for the locator's lifetime, behind a ReconnectingTransport: the object handed to
 * the app never changes, so a dropped link is an outage the widgets ride out, not a remount. The
 * transport is provided from the FIRST successful connect on (null before: nothing to subscribe
 * to yet); afterwards `status` says whether the link is up ("reconnecting" = an outage in
 * progress, queries refused at once, subscriptions re-declared when it returns).
 */
export function useTransport(locator: string): { transport: Transport | null; status: TransportStatus; error: string } {
  const [transport, setTransport] = useState<Transport | null>(null);
  const [status, setStatus] = useState<TransportStatus>("connecting");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let provided = false;
    setTransport(null);
    setStatus("connecting");
    setError("");
    const t = new ReconnectingTransport({
      open: () => ZenohRemoteApiTransport.open(locator),
      onStatus: (s, e) => {
        if (cancelled) return;
        setStatus(s);
        setError(e);
        if (s === "connected" && !provided) {
          provided = true;
          setTransport(t);
        }
      },
    });
    void t.start();
    return () => {
      cancelled = true;
      void t.close();
    };
  }, [locator]);

  return { transport, status, error };
}
