import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRosGraphContext } from "./RosGraphContext";
import type { TopicAcquireOptions, TopicSnapshot } from "./topicStore";
import type { TopicEntry } from "./graph";

export interface UseTopicResult {
  /** The graph entry, or undefined while the topic is not (yet) advertised. */
  topic: TopicEntry | undefined;
  /** Live shared data, or null until acquired. Pluck fields from snapshot.message at render. */
  snapshot: TopicSnapshot | null;
}

/**
 * Watch one ROS topic by name through the shared TopicStore. All consumers of a topic share one
 * zenoh subscription and one decode per flush — pluck what you need from the shared message.
 */
export function useTopic(topicName: string | null | undefined, opts?: TopicAcquireOptions): UseTopicResult {
  const { graph, store } = useRosGraphContext();
  const topic = topicName ? graph.topics.find((t) => t.name === topicName) : undefined;

  // Graph rebuilds mint new TopicEntry objects for the same topic — key the effect on the
  // subscription-relevant fields, never the entry object.
  const dataKeyexpr = topic?.dataKeyexpr;
  const typeName = topic?.typeName;
  const typeHash = topic?.typeHash;
  const transientLocal = topic?.transientLocal ?? false;
  const windowMs = opts?.windowMs;
  const decode = opts?.decode;

  useEffect(() => {
    if (!store || !dataKeyexpr || !typeName || !typeHash) return;
    const handle = store.acquire({ dataKeyexpr, typeName, typeHash, transientLocal }, { windowMs, decode });
    return () => handle.release();
  }, [store, dataKeyexpr, typeName, typeHash, transientLocal, windowMs, decode]);

  const subscribe = useCallback(
    (cb: () => void) => (store && dataKeyexpr ? store.subscribe(dataKeyexpr, cb) : () => undefined),
    [store, dataKeyexpr],
  );
  const getSnapshot = useCallback(
    () => (store && dataKeyexpr ? store.getSnapshot(dataKeyexpr) : null),
    [store, dataKeyexpr],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  return { topic, snapshot };
}
