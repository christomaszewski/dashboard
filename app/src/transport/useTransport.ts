import { useEffect, useState } from "react";
import { ReconnectingTransport, type LinkStatus } from "./reconnecting";
import { ZenohRemoteApiTransport } from "./zenohRemoteApi";
import type { Transport } from "./types";
import { BridgeSelection } from "./bridgeSelection";
import { connectionDiagnostics, dashboardBuild, monitorConnectionPage } from "./connectionDiagnostics";

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
    const trace = connectionDiagnostics();
    let selectedEndpoint: string | undefined;
    let nextSocket = 0;
    const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const diagnose = (event: string, detail: Record<string, unknown> = {}) => trace.record(event, {
      run, vehicleEndpoint: locator, activeEndpoint: selectedEndpoint, ...detail,
    });
    diagnose("page-connection-start", { build: dashboardBuild, localEndpoint: localLocator });
    const stopPageMonitor = monitorConnectionPage(diagnose);
    const identityKey = `dashboard.vehicle-bridge.${locator}`;
    const selection = new BridgeSelection({
      vehicleLocator: locator,
      localLocator,
      open: (endpoint, signal, timeoutMs) => {
        const socketId = `${run}/${++nextSocket}`;
        return ZenohRemoteApiTransport.open(endpoint, signal, timeoutMs, (event, detail) => diagnose(event, {
          ...detail, socketId, endpoint, route: endpoint === locator ? "vehicle" : "local",
        }));
      },
      onDiagnostic: diagnose,
      onSelected: endpoint => { selectedEndpoint = endpoint; if (!cancelled) setActiveLocator(endpoint); },
      loadVehicleId: () => {
        try { return sessionStorage.getItem(identityKey) ?? undefined; } catch { return undefined; }
      },
      saveVehicleId: id => { try { sessionStorage.setItem(identityKey, id); } catch { /* storage optional */ } },
    });
    const t = new ReconnectingTransport({
      open: () => selection.open(),
      onDiagnostic: diagnose,
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
      diagnose("page-connection-stop");
      stopPageMonitor();
      selection.close();
      void t.close();
    };
  }, [locator, localLocator]);

  return { transport, status, error, activeLocator };
}
