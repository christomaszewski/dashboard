import { useEffect, useState } from "react";
import { ReconnectingTransport, type LinkStatus } from "./reconnecting";
import { ZenohRemoteApiTransport } from "./zenohRemoteApi";
import type { Transport } from "./types";
import { BridgeSelection } from "./bridgeSelection";

export type TransportStatus = LinkStatus;

/**
 * One transport for the locator's lifetime, behind a ReconnectingTransport: the object handed to
 * the app never changes, so a dropped link is an outage the widgets ride out, not a remount. The
 * transport is provided from the FIRST successful connect on (null before: nothing to subscribe
 * to yet); afterwards `status` says whether the link is up ("reconnecting" = an outage in
 * progress, queries refused at once, subscriptions re-declared when it returns).
 */
export function useTransport(locator: string, localLocator?: string): { transport: Transport | null; status: TransportStatus; error: string; activeLocator: string } {
  const [transport, setTransport] = useState<Transport | null>(null);
  const [status, setStatus] = useState<TransportStatus>("connecting");
  const [error, setError] = useState("");
  const [activeLocator, setActiveLocator] = useState(locator);

  useEffect(() => {
    let cancelled = false;
    let provided = false;
    setTransport(null);
    setStatus("connecting");
    setError("");
    setActiveLocator(locator);
    const identityKey = `dashboard.vehicle-bridge.${locator}`;
    const selection = new BridgeSelection({
      vehicleLocator: locator,
      localLocator,
      open: (endpoint, signal, timeoutMs) => ZenohRemoteApiTransport.open(endpoint, signal, timeoutMs),
      onSelected: endpoint => { if (!cancelled) setActiveLocator(endpoint); },
      loadVehicleId: () => {
        try { return sessionStorage.getItem(identityKey) ?? undefined; } catch { return undefined; }
      },
      saveVehicleId: id => { try { sessionStorage.setItem(identityKey, id); } catch { /* storage optional */ } },
    });
    const t = new ReconnectingTransport({
      open: () => selection.open(),
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
      selection.close();
      void t.close();
    };
  }, [locator, localLocator]);

  return { transport, status, error, activeLocator };
}
