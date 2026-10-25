import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { useRosGraphContext } from "./RosGraphContext";
import type { TopicAcquireOptions, TopicSnapshot } from "./topicStore";
import type { TopicEntry } from "./graph";
import { TopicSourceCtx, VehicleStateCtx } from "../vstate/VehicleStateContext";
import { isRosTopicName, itemSignature, type FieldSpec, type ItemSpec, type SeriesSpec } from "../vstate/protocol";

export interface UseTopicOptions extends TopicAcquireOptions {
  /**
   * The fields this caller renders, each with an optional rounding quantum (its display
   * precision). With vehicle state on, only these cross the link, and only when they change
   * (docs/VEHICLE_STATE.md); `snapshot.message` then holds just these paths. The direct path
   * ignores this and decodes whole messages. Omit it to always get whole messages.
   */
  fields?: FieldSpec[];
  /** Vehicle state only: the vehicle keeps this many trail points (fields 0, 1 = latitude,
   *  longitude) and the snapshot carries them as `trail` — whole again after a reload. */
  trail?: number;
  /** Vehicle state only: the vehicle keeps the first field's min/max/last history (`history`). */
  series?: SeriesSpec;
}

export interface UseTopicResult {
  /** The graph entry, or undefined while the topic is not (yet) advertised. On the vehicle path
   *  it summarizes the vehicle's entry: name, type and domain, with empty endpoint lists. */
  topic: TopicEntry | undefined;
  /** Live shared data, or null until acquired. Pluck fields from snapshot.message at render. */
  snapshot: TopicSnapshot | null;
  /** Where the data comes from: projected by the vehicle, or raw topic samples. */
  via: "vehicle" | "direct";
}

const noSubscription = () => () => undefined;

/**
 * Watch one ROS topic by name. Directly: through the shared TopicStore (all consumers of a topic
 * share one zenoh subscription and one decode per flush — pluck what you need from the shared
 * message). Via vehicle state (Home widgets that pass `fields`, or rate-only `decode: false`
 * watches, when the instance enables it): the vehicle projects, rounds and sends changes only.
 */
export function useTopic(topicName: string | TopicEntry | null | undefined, opts?: UseTopicOptions): UseTopicResult {
  const { graph, store } = useRosGraphContext();
  const vehicle = useContext(VehicleStateCtx);
  const source = useContext(TopicSourceCtx);
  const rateOnly = opts?.decode === false;
  const viaVehicle = vehicle.enabled && source === "vehicle" && typeof topicName === "string" &&
    isRosTopicName(topicName) && (rateOnly || opts?.fields !== undefined);

  // ---- vehicle path: keyed by the item's canonical signature --------------------------------
  const itemKey = viaVehicle
    ? itemSignature({
        topic: topicName,
        fields: rateOnly ? undefined : opts?.fields,
        hz: rateOnly || undefined,
        window_ms: rateOnly && opts?.windowMs !== undefined ? Math.min(60_000, Math.max(500, opts.windowMs)) : undefined,
        trail: rateOnly ? undefined : opts?.trail,
        series: rateOnly ? undefined : opts?.series,
      })
    : null;
  const client = vehicle.client;
  useEffect(() => {
    if (!itemKey || !client) return;
    const handle = client.acquire(JSON.parse(itemKey) as ItemSpec);
    return () => handle.release();
  }, [client, itemKey]);
  // Vehicle state is on but not usable yet (runtime key missing): say so on every vehicle widget.
  const keyError = useMemo<TopicSnapshot | null>(
    () => (itemKey && vehicle.error ? { key: itemKey, error: vehicle.error } : null),
    [itemKey, vehicle.error],
  );

  // ---- direct path: the shared TopicStore -----------------------------------------------------
  const direct = viaVehicle ? undefined : typeof topicName === "object" && topicName !== null
    ? graph.topics.find((t) => t.dataKeyexpr === topicName.dataKeyexpr)
    : topicName ? graph.topics.find((t) => t.name === topicName) : undefined;
  // Graph rebuilds mint new TopicEntry objects for the same topic — key the effect on the
  // subscription-relevant fields, never the entry object.
  const dataKeyexpr = direct?.dataKeyexpr;
  const typeName = direct?.typeName;
  const typeHash = direct?.typeHash;
  const transientLocal = direct?.transientLocal ?? false;
  const windowMs = opts?.windowMs;
  const decode = opts?.decode;

  useEffect(() => {
    if (!store || !direct) return;
    const handle = store.acquire(direct, { windowMs, decode });
    return () => handle.release();
  }, [store, dataKeyexpr, typeName, typeHash, transientLocal, windowMs, decode]);

  const subscribe = useCallback(
    (cb: () => void) => {
      if (itemKey) return client ? client.subscribe(itemKey, cb) : noSubscription();
      return store && dataKeyexpr ? store.subscribe(dataKeyexpr, cb) : noSubscription();
    },
    [itemKey, client, store, dataKeyexpr],
  );
  const getSnapshot = useCallback(() => {
    if (itemKey) return client ? client.getSnapshot(itemKey) : keyError;
    return store && dataKeyexpr ? store.getSnapshot(dataKeyexpr) : null;
  }, [itemKey, client, keyError, store, dataKeyexpr]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const vehicleType = itemKey && snapshot && "typeName" in snapshot ? (snapshot.typeName as string | undefined) : undefined;
  const vehicleDomain = itemKey && snapshot && "domainId" in snapshot ? (snapshot.domainId as number | undefined) : undefined;
  const vehicleTopic = useMemo<TopicEntry | undefined>(
    () => vehicleType !== undefined && typeof topicName === "string"
      ? { name: topicName, typeName: vehicleType, typeDds: "", typeHash: "", domainId: vehicleDomain ?? 0,
          publishers: [], subscribers: [], transientLocal: false, bestEffort: false, dataKeyexpr: "" }
      : undefined,
    [topicName, vehicleType, vehicleDomain],
  );

  return itemKey ? { topic: vehicleTopic, snapshot, via: "vehicle" } : { topic: direct, snapshot, via: "direct" };
}
