import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { itemSignature, type ItemSpec } from "./protocol";
import type { VehicleSnapshot } from "./client";
import { useVehicleState } from "./VehicleStateContext";

const noSubscription = () => () => undefined;

/** One vehicle-state item that is not a topic projection (a node's presence, say); null = none. */
export function useVehicleItem(spec: ItemSpec | null): VehicleSnapshot | null {
  const { client, error } = useVehicleState();
  const key = spec ? itemSignature(spec) : null;
  useEffect(() => {
    if (!key || !client) return;
    const handle = client.acquire(JSON.parse(key) as ItemSpec);
    return () => handle.release();
  }, [client, key]);
  const keyError = useMemo<VehicleSnapshot | null>(() => (key && error ? { key, error } : null), [key, error]);
  const subscribe = useCallback((cb: () => void) => (key && client ? client.subscribe(key, cb) : noSubscription()), [client, key]);
  const getSnapshot = useCallback(() => (key ? (client ? client.getSnapshot(key) : keyError) : null), [client, key, keyError]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
