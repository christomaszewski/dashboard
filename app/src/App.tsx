import { ConfigProvider, useConfig } from "./config/ConfigContext";
import { bridgeLocators } from "./transport/locator";
import { TransportProvider } from "./transport/TransportContext";
import { StreamsProvider } from "./streams/StreamsContext";
import { RosGraphProvider } from "./ros/RosGraphContext";
import { LifecycleProvider } from "./lifecycle/LifecycleContext";
import { HealthProvider } from "./health/HealthContext";
import { PlaybackProvider } from "./playback/PlaybackContext";
import { RigProvider } from "./rig/RigContext";
import { VehicleStateProvider } from "./vstate/VehicleStateContext";
import { Shell } from "./shell/Shell";
import { RadioOptionsCtx } from "./health/RadioIndicator";

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
  const vehicleState = config.phase === "ready" && config.config.vehicle_state === true;
  const radio = config.phase === "ready" ? config.config.health?.radio : undefined;
  return (
    <TransportProvider locator={vehicleLocator} localLocator={localLocator}>
      <VehicleStateProvider enabled={vehicleState}>
        <StreamsProvider>
          <RosGraphProvider>
            <LifecycleProvider>
              <HealthProvider>
                <RadioOptionsCtx.Provider value={radio}>
                  <PlaybackProvider>
                    <RigProvider>
                      <Shell title={title} tabs={tabs} />
                    </RigProvider>
                  </PlaybackProvider>
                </RadioOptionsCtx.Provider>
              </HealthProvider>
            </LifecycleProvider>
          </RosGraphProvider>
        </StreamsProvider>
      </VehicleStateProvider>
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
