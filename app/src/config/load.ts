// Fetches the instance config YAML that dash-up bind-mounts into the web container (Caddy serves it
// at /config/dashboard.yaml, bypassing the SPA fallback so absence is a real 404). fetch is
// injectable for node-env tests.
import { parseDashboardConfig, type DashboardConfig } from "./schema";
import { setAttachmentLayout } from "../services/attachment";

export const CONFIG_URL = "/config/dashboard.yaml";

export type ConfigState =
  | { phase: "loading" }
  | { phase: "absent" } // 404 / network failure → built-in defaults (default Home, default ws port)
  | { phase: "ready"; config: DashboardConfig }
  | { phase: "error"; message: string }; // fetched but unparseable YAML (message carries line/col)

export async function loadDashboardConfig(fetchFn: typeof fetch = fetch): Promise<ConfigState> {
  let text: string;
  try {
    const res = await fetchFn(CONFIG_URL, { cache: "no-store" });
    if (!res.ok) return { phase: "absent" };
    text = await res.text();
  } catch {
    return { phase: "absent" };
  }
  try {
    const config = parseDashboardConfig(text);
    setAttachmentLayout(config.rmw_attachment ?? "plain"); // before any service call can happen
    return { phase: "ready", config };
  } catch (e) {
    return { phase: "error", message: `config YAML is unparseable: ${e instanceof Error ? e.message : String(e)}` };
  }
}
