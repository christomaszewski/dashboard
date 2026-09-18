import { readTransform, type TransformSample } from "./tf";

export interface ReplayState {
  run: string; epoch: number; player: string; position: bigint; begin: bigint; end: bigint;
  static: TransformSample[]; dynamic: TransformSample[];
}
export function readReplayState(data: unknown): ReplayState {
  if (typeof data !== "string" || data.length > 2 * 1024 * 1024) throw new Error("invalid replay snapshot");
  const v = JSON.parse(data);
  if (v.version !== 1 || typeof v.run !== "string" || !v.run || !Number.isSafeInteger(v.epoch) || v.epoch < 0 ||
      typeof v.player !== "string" || !v.player.startsWith("/")) throw new Error("invalid replay identity");
  const time = (value: unknown): bigint => {
    if (typeof value !== "string" || !/^\d{1,19}$/.test(value)) throw new Error("invalid replay time");
    return BigInt(value);
  };
  const transforms = (value: unknown) => {
    if (!Array.isArray(value) || value.length > 2048) throw new Error("invalid replay transforms");
    return value.map((tf) => readTransform(tf, `replay/${v.run}`));
  };
  const state = { run: v.run, epoch: v.epoch, player: v.player, position: time(v.position), begin: time(v.begin), end: time(v.end),
    static: transforms(v.static), dynamic: transforms(v.dynamic) };
  if (state.end < state.begin || state.position < state.begin || state.position > state.end) throw new Error("invalid replay interval");
  return state;
}
