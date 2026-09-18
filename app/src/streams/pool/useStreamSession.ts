import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useStreamsContext } from "../StreamsContext";
import type { SessionSnapshot, StreamHandle } from "./sessionPool";

/**
 * React glue for the session pool: acquires the stream on mount, releases on cleanup, and wires the
 * <video> element via a callback ref (refs and effects rendezvous through refs — callback refs fire
 * before effects on mount and detach before cleanup on unmount, so both sides handle either order).
 * `key: null` acquires nothing (placeholder tiles waiting on discovery).
 */
export function useStreamSession(key: string | null): {
  snapshot: SessionSnapshot | null;
  videoRef: (el: HTMLVideoElement | null) => void;
} {
  const { pool } = useStreamsContext();
  const handleRef = useRef<StreamHandle | null>(null);
  const elRef = useRef<HTMLVideoElement | null>(null);

  const videoRef = useCallback((el: HTMLVideoElement | null) => {
    if (elRef.current && elRef.current !== el) handleRef.current?.detach(elRef.current);
    elRef.current = el;
    if (el) handleRef.current?.attach(el);
  }, []);

  useEffect(() => {
    if (!key) return;
    const handle = pool.acquire(key);
    handleRef.current = handle;
    if (elRef.current) handle.attach(elRef.current);
    return () => {
      if (elRef.current) handle.detach(elRef.current);
      handle.release();
      handleRef.current = null;
    };
  }, [pool, key]);

  const subscribe = useCallback(
    (cb: () => void) => (key ? pool.subscribe(key, cb) : () => undefined),
    [pool, key],
  );
  const getSnapshot = useCallback(() => (key ? pool.getSnapshot(key) : null), [pool, key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  return { snapshot, videoRef };
}
