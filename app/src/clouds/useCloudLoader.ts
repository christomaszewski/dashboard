import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadRequest, LoadResponse } from "./vendor/loaders/loadWorker";
import type { PointCloudData } from "./vendor/loaders/types";

export type CloudLoadState =
  | { phase: "idle" }
  | { phase: "loading"; message: string }
  | { phase: "ready"; name: string; cloud: PointCloudData; parseMs: number }
  | { phase: "error"; message: string };

/**
 * Worker-backed BPF loading (port of upstream main.ts loadBuffer/loadUrl). The worker URL is
 * relative to THIS module — keep the hook beside `vendor/` or the Vite worker build breaks.
 */
export function useCloudLoader() {
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);
  const [state, setState] = useState<CloudLoadState>({ phase: "idle" });

  useEffect(() => {
    const worker = new Worker(new URL("./vendor/loaders/loadWorker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const loadBuffer = useCallback((name: string, buffer: ArrayBuffer) => {
    const worker = workerRef.current;
    if (!worker) return;
    const id = ++requestId.current;
    setState({ phase: "loading", message: `Parsing ${name} (${(buffer.byteLength / 1e6).toFixed(1)} MB)…` });
    worker.onmessage = (ev: MessageEvent<LoadResponse>) => {
      if (ev.data.id !== id) return; // a newer request superseded this one
      if (!ev.data.ok) setState({ phase: "error", message: ev.data.error });
      else setState({ phase: "ready", name, cloud: ev.data.data, parseMs: ev.data.parseMs });
    };
    worker.postMessage({ id, name, buffer } satisfies LoadRequest, [buffer]);
  }, []);

  const loadUrl = useCallback(
    async (url: string) => {
      setState({ phase: "loading", message: `Fetching ${url}…` });
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
        loadBuffer(url.split("/").pop() || url, await res.arrayBuffer());
      } catch (e) {
        setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [loadBuffer],
  );

  return { state, loadBuffer, loadUrl };
}
