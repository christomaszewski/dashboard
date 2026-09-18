/// <reference lib="webworker" />
import { parseFile } from './index';
import { transferables } from './types';

export interface LoadRequest {
  id: number;
  name: string;
  buffer: ArrayBuffer;
}

export type LoadResponse =
  | { id: number; ok: true; data: import('./types').PointCloudData; parseMs: number }
  | { id: number; ok: false; error: string };

self.onmessage = async (ev: MessageEvent<LoadRequest>) => {
  const { id, name, buffer } = ev.data;
  try {
    const t0 = performance.now();
    const data = await parseFile(name, buffer);
    const parseMs = performance.now() - t0;
    const msg: LoadResponse = { id, ok: true, data, parseMs };
    (self as unknown as Worker).postMessage(msg, transferables(data));
  } catch (e) {
    const msg: LoadResponse = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
    (self as unknown as Worker).postMessage(msg);
  }
};
