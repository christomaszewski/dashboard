import { createContext, useContext, type ReactNode } from "react";
import type { Transport } from "./types";
import { useTransport, type TransportStatus } from "./useTransport";

export interface TransportContextValue {
  transport: Transport | null;
  status: TransportStatus;
  error: string;
  /** The locator the session was dialed with (topbar display). */
  locator: string;
}

/** The raw context — for tests and extensions that provide a value without the live provider. */
export const TransportCtx = createContext<TransportContextValue | null>(null);

/** One zenoh session for the app; the locator is resolved by the caller (config-aware). */
export function TransportProvider({ locator, localLocator, children }: { locator: string; localLocator?: string; children: ReactNode }) {
  const { transport, status, error, activeLocator } = useTransport(locator, localLocator);
  return <TransportCtx.Provider value={{ transport, status, error, locator: activeLocator }}>{children}</TransportCtx.Provider>;
}

export function useTransportContext(): TransportContextValue {
  const v = useContext(TransportCtx);
  if (!v) throw new Error("useTransportContext must be used inside <TransportProvider>");
  return v;
}
