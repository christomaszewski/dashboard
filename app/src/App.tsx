import { ConfigProvider, useConfig } from "./config/ConfigContext";
import { remoteApiLocator } from "./transport/locator";
import { TransportProvider } from "./transport/TransportContext";
import { StreamsProvider } from "./streams/StreamsContext";
import { RosGraphProvider } from "./ros/RosGraphContext";
import { LifecycleProvider } from "./lifecycle/LifecycleContext";
import { Shell } from "./shell/Shell";

function ConnectedApp() {
  const config = useConfig();
  // Resolve the instance config BEFORE dialing: it may carry a non-default ws_port. `absent`/`error`
  // fall through to defaults — the dashboard must come up with no config mounted at all.
  if (config.phase === "loading") return null;
  const wsPort = config.phase === "ready" ? config.config.ws_port : undefined;
  const title = config.phase === "ready" ? config.config.home?.title : undefined;
  const tabs = config.phase === "ready" ? config.config.tabs : undefined;
  return (
    <TransportProvider locator={remoteApiLocator(wsPort)}>
      <StreamsProvider>
        <RosGraphProvider>
          <LifecycleProvider>
            <Shell title={title} tabs={tabs} />
          </LifecycleProvider>
        </RosGraphProvider>
      </StreamsProvider>
    </TransportProvider>
  );
}

export function App() {
  return (
    <ConfigProvider>
      <ConnectedApp />
    </ConfigProvider>
  );
}
