// @vitest-environment jsdom
// The component-test harness: the app's contexts provided with plain values (no zenoh, no
// signalling) around a REAL StreamSessionPool whose sources are fakes — so a tile's acquire /
// attach / release path runs for real and only the media negotiation is stubbed. Each test file
// opts into jsdom itself (`// @vitest-environment jsdom`); the unit suites stay in node.
import { render, type RenderResult } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import type { LifecycleService } from "../lifecycle/types";
import { LifecycleCtx } from "../lifecycle/LifecycleContext";
import type { PlaybackDescriptor, PlaybackService } from "../playback/types";
import { PlaybackCtx } from "../playback/PlaybackContext";
import { EMPTY_GRAPH, type RosGraph } from "../ros/graph";
import { RosGraphCtx } from "../ros/RosGraphContext";
import { StreamSessionPool } from "../streams/pool/sessionPool";
import type { StreamSource, StreamSourceHooks } from "../streams/source/types";
import { StreamsCtx } from "../streams/StreamsContext";
import type { DiscoveredStream, StreamDescriptor } from "../streams/types";
import { TransportCtx } from "../transport/TransportContext";

/** jsdom 30 under vitest exposes no localStorage; the widgets remember choices through the bare
 *  global, so give them an in-memory Storage (same contract, cleared per test by the callers). */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}
if (typeof (globalThis as { localStorage?: Storage }).localStorage === "undefined") {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
}

class FakeSource implements StreamSource {
  hooks: StreamSourceHooks | null = null;
  constructor(readonly descriptor: StreamDescriptor) {}
  open(hooks: StreamSourceHooks): Promise<void> {
    this.hooks = hooks;
    return Promise.resolve();
  }
  close(): void {
    this.hooks = null;
  }
}

/** jsdom's media element implements neither play() nor srcObject — the pool calls both once media
 *  arrives; give it inert versions so an attached tile never throws. */
export function stubMediaElement(): void {
  const proto = HTMLMediaElement.prototype as unknown as { play: () => Promise<void> };
  proto.play = () => Promise.resolve();
}

export function stream(sensorId: string, d: Partial<StreamDescriptor> = {}, alive = true): DiscoveredStream {
  return {
    key: `fleet/1/media/${sensorId}`,
    vehicleId: "1",
    sensorId,
    alive,
    descriptor: {
      schema_version: 1,
      id: sensorId,
      producer: "camera-service",
      protocol: "gstwebrtc-api",
      signalling: "ws://veh:8443",
      producer_id: `${sensorId}-webrtc`,
      role: sensorId,
      codec: "H264",
      width: 640,
      height: 480,
      ...d,
    },
  };
}

export function lifecycle(instance: string, state = "inactive", transitions = ["activate"]): LifecycleService {
  return {
    key: `fleet/1/svc/${instance}/lifecycle`,
    vehicleId: "1",
    instance,
    alive: true,
    descriptor: { schema_version: 1, service: "camera-service", instance, state, transitions },
  };
}

export function playback(instance: string, d: Partial<PlaybackDescriptor> = {}): PlaybackService {
  return {
    key: `fleet/1/svc/${instance}/playback`,
    vehicleId: "1",
    instance,
    alive: true,
    descriptor: {
      schema_version: 1,
      service: "camera-service",
      instance,
      source: "replay",
      state: "playing",
      controls: ["pause", "set_speed", "set_loop", "restart"],
      speed: 1,
      loop: true,
      cycle: 0,
      position_s: 1.5,
      duration_s: 4,
      frames: 37,
      ...d,
    },
  };
}

type TransportValue = NonNullable<ComponentProps<typeof TransportCtx.Provider>["value"]>;

export interface World {
  streams?: DiscoveredStream[];
  services?: LifecycleService[];
  playbacks?: PlaybackService[];
  /** The ROS graph as liveliness would have built it (services, nodes, topics). Default: empty. */
  graph?: RosGraph;
  /** A transport handle — null (the default) renders every service-calling control disabled; tests
   *  that mock `callService` pass any object to stand in for a connected session. */
  transport?: TransportValue["transport"];
}

function finder<T extends { instance: string; vehicleId: string }>(items: T[]) {
  return (ref: string) => {
    const slash = ref.indexOf("/");
    if (slash > 0) return items.find((s) => s.vehicleId === ref.slice(0, slash) && s.instance === ref.slice(slash + 1));
    return items.find((s) => s.instance === ref);
  };
}

/** Render `ui` inside the app's contexts. Returns RTL's result plus the pool (to inspect sessions). */
export function renderWith(ui: ReactElement, world: World = {}): RenderResult & { pool: StreamSessionPool } {
  stubMediaElement();
  const streams = world.streams ?? [];
  const pool = new StreamSessionPool({ createSource: (d) => new FakeSource(d) });
  pool.updateStreams(streams);
  const services = world.services ?? [];
  const playbacks = world.playbacks ?? [];
  const result = render(
    <TransportCtx.Provider value={{ transport: world.transport ?? null, status: "connected", error: "", locator: "ws://test" }}>
      <RosGraphCtx.Provider value={{ graph: world.graph ?? EMPTY_GRAPH, resolver: null, store: null }}>
        <StreamsCtx.Provider value={{ streams, pool }}>
          <LifecycleCtx.Provider value={{ services, find: finder(services) }}>
            <PlaybackCtx.Provider value={{ services: playbacks, find: finder(playbacks) }}>{ui}</PlaybackCtx.Provider>
          </LifecycleCtx.Provider>
        </StreamsCtx.Provider>
      </RosGraphCtx.Provider>
    </TransportCtx.Provider>,
  );
  return Object.assign(result, { pool });
}
