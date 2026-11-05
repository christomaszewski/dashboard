import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { VehicleStateClient } from "../vstate/client";
import { itemSignature } from "../vstate/protocol";

const RUN_SPEC = { current_run: true } as const;
const RUN_KEY = itemSignature(RUN_SPEC);
const noSubscription = () => () => undefined;

/** A single item on the shared vehicle-state view; no agent discovery or topic subscription. */
export function useCurrentRun(client: VehicleStateClient | null | undefined) {
  useEffect(() => {
    if (!client) return;
    const handle = client.acquire(RUN_SPEC);
    return handle.release;
  }, [client]);
  const subscribe = useCallback((cb: () => void) => client ? client.subscribe(RUN_KEY, cb) : noSubscription(), [client]);
  const getSnapshot = useCallback(() => client?.getSnapshot(RUN_KEY) ?? null, [client]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
