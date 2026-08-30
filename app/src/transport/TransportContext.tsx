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

const Ctx = createContext<TransportContextValue | null>(null);

/** One zenoh session for the app; the locator is resolved by the caller (config-aware). */
export function TransportProvider({ locator, children }: { locator: string; children: ReactNode }) {
  const { transport, status, error } = useTransport(locator);
  return <Ctx.Provider value={{ transport, status, error, locator }}>{children}</Ctx.Provider>;
}

export function useTransportContext(): TransportContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTransportContext must be used inside <TransportProvider>");
  return v;
}
