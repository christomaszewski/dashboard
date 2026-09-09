import { compose, frameId, identity, interpolate, inverse, stampNs, type Quat, type RigidTransform, type Vec3 } from "./math";

export type TfErrorCode = "unknown-frame" | "disconnected" | "past" | "future" | "conflict" | "cycle" | "zero-stamp";
export class TfError extends Error {
  constructor(public code: TfErrorCode, message: string) { super(message); }
}
export interface TransformSample extends RigidTransform { parent: string; child: string; stamp: bigint; authority?: string }
export interface FrameInfo { child: string; parent: string; static: boolean; stamp: bigint; samples: number }

export function readTransform(value: unknown, authority?: string): TransformSample {
  const v = value as { header?: { frame_id?: unknown; stamp?: unknown }; child_frame_id?: unknown;
    transform?: { translation?: { x: number; y: number; z: number }; rotation?: { x: number; y: number; z: number; w: number } } };
  const parent = frameId(v?.header?.frame_id); const child = frameId(v?.child_frame_id);
  if (parent === child) throw new Error(`TF self-parent: ${child}`);
  const p = v.transform?.translation; const q = v.transform?.rotation;
  if (!p || !q) throw new Error("missing transform");
  const translation: Vec3 = [p.x, p.y, p.z]; const rotation: Quat = [q.x, q.y, q.z, q.w];
  if (![...translation, ...rotation].every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("non-finite transform");
  const norm = Math.hypot(...rotation);
  if (Math.abs(norm - 1) > 0.01) throw new Error(`invalid quaternion for ${child} (norm ${norm})`);
  return { parent, child, translation, rotation: rotation.map((n) => n / norm) as Quat, stamp: stampNs(v.header?.stamp), authority };
}

/** Timestamped TF tree. Static edges never age; dynamic history is bounded per child. */
export class TfBuffer {
  private dynamic = new Map<string, TransformSample[]>();
  private statics = new Map<string, TransformSample>();
  private conflicts = new Map<string, string>();
  private knownNames = new Set<string>();
  constructor(private historyNs = 10_000_000_000n, private maxSamples = 2000, private maxFrames = 1024) {}

  clear(keepStatic = false): void {
    this.dynamic.clear(); this.conflicts.clear(); if (!keepStatic) this.statics.clear();
    this.knownNames = new Set([...this.statics.values()].flatMap((s) => [s.parent, s.child]));
  }
  insert(sample: TransformSample, isStatic: boolean): void {
    const { child } = sample;
    for (const name of [sample.parent, child]) {
      if (!this.knownNames.has(name) && this.knownNames.size >= this.maxFrames) throw new Error("TF frame budget exceeded");
      this.knownNames.add(name);
    }
    if (!this.dynamic.has(child) && !this.statics.has(child) && this.dynamic.size + this.statics.size >= this.maxFrames)
      throw new Error("TF frame budget exceeded");
    if ((isStatic && this.dynamic.has(child)) || (!isStatic && this.statics.has(child))) {
      this.conflicts.set(child, `both static and dynamic publishers own ${child}`); return;
    }
    if (isStatic) {
      const old = this.statics.get(child);
      if (old && !samePose(old, sample) && (old.authority !== sample.authority || !sample.authority)) {
        this.conflicts.set(child, `conflicting static transforms for ${child}`); return;
      }
      this.statics.set(child, sample); return;
    }
    const samples = this.dynamic.get(child) ?? [];
    const latest = samples.at(-1);
    if (latest && sample.stamp < latest.stamp - this.historyNs) return;
    // Binary insertion also accepts ordinary out-of-order delivery.
    let lo = 0; let hi = samples.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (samples[mid].stamp < sample.stamp) lo = mid + 1; else hi = mid; }
    const old = samples[lo];
    if (old?.stamp === sample.stamp) {
      if (!samePose(old, sample)) this.conflicts.set(child, `conflicting transforms for ${child} at ${sample.stamp}`);
      return;
    }
    if (latest?.authority && sample.authority && latest.authority !== sample.authority) {
      this.conflicts.set(child, `multiple dynamic authorities for ${child}`); return;
    }
    samples.splice(lo, 0, sample);
    const cutoff = samples[samples.length - 1].stamp - this.historyNs;
    let remove = 0;
    while (remove < samples.length && samples[remove].stamp < cutoff) remove++;
    remove = Math.max(remove, samples.length - this.maxSamples);
    if (remove) samples.splice(0, remove);
    this.dynamic.set(child, samples);
  }

  frames(): FrameInfo[] {
    return [...[...this.statics.values()].map((s) => ({ child: s.child, parent: s.parent, stamp: s.stamp, static: true, samples: 1 })),
      ...[...this.dynamic.values()].filter((a) => a.length).map((a) => ({ child: a[0].child, parent: a[a.length - 1].parent,
        stamp: a[a.length - 1].stamp, static: false, samples: a.length }))].sort((a, b) => a.child.localeCompare(b.child));
  }
  names(): string[] { return [...this.knownNames].sort(); }
  diagnostics(): string[] { return [...this.conflicts.values()]; }

  private edge(child: string, time: bigint): TransformSample | undefined {
    const conflict = this.conflicts.get(child);
    if (conflict) throw new TfError("conflict", conflict);
    const fixed = this.statics.get(child); if (fixed) return fixed;
    const a = this.dynamic.get(child); if (!a?.length) return undefined;
    if (time === 0n) throw new TfError("zero-stamp", "zero-stamped cloud needs an explicit acquisition time for dynamic TF");
    if (time < a[0].stamp) throw new TfError("past", `${child}: requested ${time}, oldest TF ${a[0].stamp}`);
    if (time > a[a.length - 1].stamp) throw new TfError("future", `${child}: requested ${time}, latest TF ${a[a.length - 1].stamp}`);
    let lo = 0; let hi = a.length - 1;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (a[mid].stamp < time) lo = mid + 1; else hi = mid; }
    if (a[lo].stamp === time) return a[lo];
    const before = a[lo - 1]; const after = a[lo];
    if (before.parent !== after.parent) throw new TfError("conflict", `${child}: parent changed across requested time`);
    return { ...before, stamp: time, ...interpolate(before, after, Number(time - before.stamp) / Number(after.stamp - before.stamp)) };
  }

  private ancestors(frame: string, time: bigint): { poses: Map<string, RigidTransform>; error?: Error } {
    const poses = new Map<string, RigidTransform>([[frame, identity()]]);
    let current = frame; let pose = identity();
    try {
      for (let depth = 0; depth <= this.maxFrames; depth++) {
        const edge = this.edge(current, time); if (!edge) return { poses };
        if (poses.has(edge.parent)) throw new TfError("cycle", `TF cycle through ${edge.parent}`);
        pose = compose(edge, pose); current = edge.parent; poses.set(current, pose);
      }
      throw new TfError("cycle", "TF chain exceeds frame budget");
    } catch (error) { return { poses, error: error as Error }; }
  }

  lookup(target: string, source: string, time: bigint): RigidTransform {
    frameId(target); frameId(source);
    if (target === source) return identity();
    const names = this.names();
    for (const frame of [target, source]) if (!names.includes(frame)) throw new TfError("unknown-frame", `unknown frame: ${frame}`);
    const from = this.ancestors(source, time); const to = this.ancestors(target, time);
    if ((from.error as TfError)?.code === "cycle") throw from.error;
    if ((to.error as TfError)?.code === "cycle") throw to.error;
    for (const [ancestor, pose] of from.poses) {
      const targetPose = to.poses.get(ancestor);
      if (targetPose) return compose(inverse(targetPose), pose);
    }
    throw from.error ?? to.error ?? new TfError("disconnected", `no TF path from ${source} to ${target}`);
  }

  /** Latest COMMON time, never a composition of unrelated per-edge latest timestamps. */
  latest(target: string, source: string): { transform: RigidTransform; stamp: bigint } {
    const times = [...new Set([...this.dynamic.values()].map((a) => a[a.length - 1].stamp))].sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
    let error: unknown;
    for (const stamp of [...times, 0n]) {
      try { return { transform: this.lookup(target, source, stamp), stamp }; } catch (e) { error = e; }
    }
    throw error;
  }
}

function samePose(a: TransformSample, b: TransformSample): boolean {
  return a.parent === b.parent && a.translation.every((v, i) => Math.abs(v - b.translation[i]) < 1e-9) &&
    Math.abs(Math.abs(a.rotation.reduce((sum, v, i) => sum + v * b.rotation[i], 0)) - 1) < 1e-9;
}
