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
