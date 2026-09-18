import { ConfigProvider, useConfig } from "./config/ConfigContext";
import { bridgeLocators } from "./transport/locator";
import { TransportProvider } from "./transport/TransportContext";
import { StreamsProvider } from "./streams/StreamsContext";
import { RosGraphProvider } from "./ros/RosGraphContext";
import { LifecycleProvider } from "./lifecycle/LifecycleContext";
import { PlaybackProvider } from "./playback/PlaybackContext";
import { RigProvider } from "./rig/RigContext";
import { Shell } from "./shell/Shell";

function ConnectedApp() {
  const config = useConfig();
  // Resolve the instance config BEFORE dialing: it may carry a non-default ws_port. `absent`/`error`
  // fall through to defaults — the dashboard must come up with no config mounted at all.
  if (config.phase === "loading") return null;
  const wsPort = config.phase === "ready" ? config.config.ws_port : undefined;
  const localBridge = config.phase === "ready" ? config.config.local_bridge : undefined;
  const { vehicleLocator, localLocator } = bridgeLocators(wsPort, localBridge);
  const title = config.phase === "ready" ? config.config.home?.title : undefined;
  const tabs = config.phase === "ready" ? config.config.tabs : undefined;
  return (
    <TransportProvider locator={vehicleLocator} localLocator={localLocator}>
      <StreamsProvider>
        <RosGraphProvider>
          <LifecycleProvider>
            <PlaybackProvider>
              <RigProvider>
                <Shell title={title} tabs={tabs} />
              </RigProvider>
            </PlaybackProvider>
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
