import { remoteApiLocator } from "./config";
import { useTransport } from "./transport/useTransport";
import { StreamGrid } from "./streams/StreamGrid";
import { KeyspaceDebug } from "./debug/KeyspaceDebug";

export function App() {
  const { transport, status, error } = useTransport();
  const statusColor = status === "connected" ? "#2a7" : status === "error" ? "#c33" : "#888";

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: "60rem", lineHeight: 1.5 }}>
      <h1>
        Vehicle Dashboard <small style={{ color: "#888", fontWeight: 400 }}>· Phase 1</small>
      </h1>
      <p>
        remote-api: <code>{remoteApiLocator()}</code> — status:{" "}
        <strong style={{ color: statusColor }}>{status}</strong>
      </p>
      {status === "error" && (
        <pre style={{ color: "#c33", whiteSpace: "pre-wrap", background: "#fee", padding: ".75rem", borderRadius: 6 }}>
          {error}
          {"\n\n"}Is the dashboard-zenoh sidecar up and reachable at that locator?
        </pre>
      )}
      {transport && <StreamGrid transport={transport} />}
      {transport && <KeyspaceDebug transport={transport} />}
    </main>
  );
}
