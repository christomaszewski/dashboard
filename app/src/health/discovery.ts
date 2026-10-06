import type { Subscription, Transport } from "../transport/types";
import { SeriesBuffer, type SeriesPoint } from "../home/widgets/primitives/series";
import {
  HEALTH_PATTERN,
  HEALTH_STATE_PATTERN,
  parseHealthKey,
  parseHealthSnapshot,
  temperatureWhere,
  type HealthService,
} from "./types";

/** A withdrawn token is held this long before the instance disappears — the lifecycle grace: a
 *  crash restart re-declares within seconds, and the last readings are worth keeping on screen
 *  (marked offline) while it does. */
export const HEALTH_OFFLINE_GRACE_MS = 15_000;

/** Temperature history kept per value, for the trend lines. Ten minutes at the default 1 Hz. */
export const HEALTH_HISTORY_MS = 10 * 60_000;
const HISTORY_MAX_POINTS = 1_200;
const NO_POINTS: readonly SeriesPoint[] = [];

const seriesKey = (key: string, statusName: string, valueKey: string) => `${key}\n${statusName}\n${valueKey}`;

/**
 * Discovers every service instance publishing health (camera-service today; the key convention is
 * service-agnostic). Presence = liveliness on `fleet/*\/svc/*\/health` (history-backed, so
 * already-running services arrive as PUTs); on PUT we `get` the same key for the latest snapshot,
 * and every later one arrives on the `…/state` publications at the producer's own interval.
 *
 * It also keeps the recent history of every `temp.<where>_c` value: temperatures move slowly, so
 * the trend is the reading. The history lives here (one per app, not per widget) so it survives a
 * tab switch.
 */
export class HealthDiscovery {
  private tokenSub: Subscription | null = null;
  private stateSub: Subscription | null = null;
  private readonly services = new Map<string, HealthService>();
  private readonly removals = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly history = new Map<string, SeriesBuffer>();

  constructor(
    private readonly transport: Transport,
    private readonly graceMs: number = HEALTH_OFFLINE_GRACE_MS,
  ) {}

  async start(onChange: (services: HealthService[]) => void): Promise<void> {
    const emit = () => onChange([...this.services.values()].sort((a, b) => a.key.localeCompare(b.key)));

    this.tokenSub = await this.transport.liveliness.subscribe(HEALTH_PATTERN, (e) => {
      if (!parseHealthKey(e.keyexpr)) return;
      if (!e.alive) {
        const entry = this.services.get(e.keyexpr);
        if (!entry) return;
        this.services.set(e.keyexpr, { ...entry, alive: false });
        this.cancelRemoval(e.keyexpr);
        this.removals.set(
          e.keyexpr,
          setTimeout(() => {
            this.removals.delete(e.keyexpr);
            if (this.services.get(e.keyexpr)?.alive === false) {
              this.services.delete(e.keyexpr);
              this.forget(e.keyexpr);
              emit();
            }
          }, this.graceMs),
        );
        emit();
        return;
      }
      this.cancelRemoval(e.keyexpr);
      void this.fetch(e.keyexpr, emit);
    });

    // A publication for a key we have not seen yet (missed token, or the token still landing)
    // creates the entry — the snapshot is the same.
    this.stateSub = await this.transport.subscribe(HEALTH_STATE_PATTERN, (s) => {
      if (s.kind !== "put") return;
      this.apply(s.keyexpr.replace(/\/state$/, ""), s.payload, emit);
    });
  }

  /** The recent history of one temperature value (oldest first; `t` is this browser's clock, ms). */
  series(key: string, statusName: string, valueKey: string): readonly SeriesPoint[] {
    return this.history.get(seriesKey(key, statusName, valueKey))?.points ?? NO_POINTS;
  }

  private cancelRemoval(key: string): void {
    const t = this.removals.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      this.removals.delete(key);
    }
  }

  private forget(key: string): void {
    for (const k of this.history.keys()) if (k.startsWith(`${key}\n`)) this.history.delete(k);
  }

  private apply(key: string, payload: Uint8Array, emit: () => void): void {
    const parsed = parseHealthKey(key);
    const snapshot = parseHealthSnapshot(payload);
    if (!parsed || !snapshot) return; // malformed → skip
    // Contract: `instance` MUST equal the key's <instance> segment.
    if (snapshot.instance !== parsed.instance) return;
    const now = Date.now();
    const previous = this.services.get(key);
    this.services.set(key, {
      key,
      ...parsed,
      snapshot,
      alive: true,
      receivedAtMs: now,
      periodMs: previous ? now - previous.receivedAtMs : undefined,
    });
    for (const status of snapshot.status) {
      for (const [valueKey, value] of Object.entries(status.values)) {
        if (typeof value !== "number" || temperatureWhere(valueKey) === null) continue;
        const k = seriesKey(key, status.name, valueKey);
        let buffer = this.history.get(k);
        if (!buffer) this.history.set(k, (buffer = new SeriesBuffer(HEALTH_HISTORY_MS, HISTORY_MAX_POINTS)));
        buffer.push(now, value);
      }
    }
    emit();
  }

  private async fetch(key: string, emit: () => void): Promise<void> {
    try {
      const [reply] = await this.transport.get(key);
      if (reply) this.apply(key, reply.payload, emit);
    } catch {
      // best-effort; a failed fetch just omits the instance until its next publication
    }
  }

  async stop(): Promise<void> {
    await this.tokenSub?.close();
    await this.stateSub?.close();
    this.tokenSub = null;
    this.stateSub = null;
    for (const key of this.removals.keys()) this.cancelRemoval(key);
    this.services.clear();
    this.history.clear();
  }
}
