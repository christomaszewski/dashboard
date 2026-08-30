import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { loadDashboardConfig, type ConfigState } from "./load";

const Ctx = createContext<ConfigState | null>(null);

/** Outermost provider: resolves the instance config before the transport dials (ws_port). */
export function ConfigProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfigState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    void loadDashboardConfig().then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useConfig(): ConfigState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useConfig must be used inside <ConfigProvider>");
  return v;
}
