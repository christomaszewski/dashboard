import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
// Widget registrations — built-ins first, then project extensions (which may override).
import "./widgets/builtins";
import "./extensions";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline app shell (public/sw.js): a reload while the vehicle is out of reach still opens the
// dashboard. Browsers allow service workers only over HTTPS or on localhost; over plain HTTP the
// long-lived asset caching (deploy/Caddyfile) is what remains.
if (import.meta.env.PROD && "serviceWorker" in navigator && window.isSecureContext) {
  const register = () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  // The entry module awaits its WebAssembly at top level, so `load` may already have fired.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
