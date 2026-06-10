import { remoteApiLocator } from "./config";
import { useTransport } from "./transport/useTransport";
import { StreamGrid } from "./streams/StreamGrid";
import { RosExplorer } from "./ros/RosExplorer";
import { KeyspaceDebug } from "./debug/KeyspaceDebug";

export function App() {
  const { transport, status, error } = useTransport();
  const pillClass = status === "connected" ? "ok" : status === "error" ? "err" : "warn";

  return (
    <>
      <header className="topbar">
        <span className="brand">
          Vehicle Dashboard<small>Phase 1</small>
        </span>
        <span className="spacer" />
        <span className="locator">{remoteApiLocator()}</span>
        <span className={`pill ${pillClass}`}>{status}</span>
      </header>
      <main className="page">
        {status === "error" && (
          <div className="error-box">
            {error}
            {"\n\n"}Is the dashboard-zenoh sidecar up and reachable at that locator?
          </div>
        )}
        {transport && <StreamGrid transport={transport} />}
        {transport && <RosExplorer transport={transport} />}
        {transport && <KeyspaceDebug transport={transport} />}
      </main>
    </>
  );
}
