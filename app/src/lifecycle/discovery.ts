import type { Subscription, Transport } from "../transport/types";
import {
  LIFECYCLE_PATTERN,
  LIFECYCLE_STATE_PATTERN,
  parseLifecycleDescriptor,
  parseLifecycleKey,
  type LifecycleService,
} from "./types";

/** A withdrawn token is held this long before the service disappears: a crash restart re-declares
 *  within seconds (and resumes its last state), and dropping the card mid-restart loses the
 *  operator's context. Shorter than the media grace — no playback is at stake. */
export const LIFECYCLE_OFFLINE_GRACE_MS = 15_000;
const REFRESH_MS = 15_000;
const RETRY_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

/**
 * Discovers lifecycle-controlled services (camera-service recorders today; the key convention is
 * service-agnostic). Presence = liveliness on `fleet/*\/svc/*\/lifecycle` (history-backed, so
 * already-running services arrive as PUTs); on PUT we `get` the same key for the JSON descriptor.
 * Live state changes arrive on the `…/state` publications, so a transition made by anyone (this
 * dashboard, another operator, a SIGUSR from a shell) updates every viewer immediately. Read-only
 * descriptor queries also recover a failed initial fetch or a lost transition publication.
 */
export class LifecycleDiscovery {
  private closed = false;
  private readonly subs: Subscription[] = [];
  private readonly services = new Map<string, LifecycleService>();
  private readonly removals = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly refreshes = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly presence = new Map<string, boolean>();
  private readonly generations = new Map<string, number>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly transport: Transport,
    private readonly graceMs: number = LIFECYCLE_OFFLINE_GRACE_MS,
  ) {}

  async start(onChange: (services: LifecycleService[]) => void): Promise<void> {
    if (this.closed) return;
    const emit = () => {
      if (!this.closed) onChange([...this.services.values()].sort((a, b) => a.key.localeCompare(b.key)));
    };

    await this.keep(await this.transport.liveliness.subscribe(LIFECYCLE_PATTERN, (e) => {
      if (this.closed || !parseLifecycleKey(e.keyexpr)) return;
      this.presence.set(e.keyexpr, e.alive);
      this.generation(e.keyexpr);
      this.cancelRefresh(e.keyexpr);
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
              emit();
            }
          }, this.graceMs),
        );
        emit();
        return;
      }
      this.cancelRemoval(e.keyexpr);
      void this.fetch(e.keyexpr, emit);
    }));
    if (this.closed) return;

    // Descriptor publications on every transition. A publication for a key we have not seen yet
    // (missed token, or the token still landing) creates the entry — the descriptor is the same.
    await this.keep(await this.transport.subscribe(LIFECYCLE_STATE_PATTERN, (s) => {
      if (this.closed || s.kind !== "put") return;
      const key = s.keyexpr.replace(/\/state$/, "");
      if (this.presence.get(key) === false || !this.apply(key, s.payload, emit)) return;
      this.generation(key); // a delayed query cannot overwrite this newer publication
      this.presence.set(key, true);
      this.scheduleRefresh(key, REFRESH_MS, emit);
    }));
  }

  private async keep(sub: Subscription): Promise<void> {
    if (this.closed) await sub.close();
    else this.subs.push(sub);
  }

  private generation(key: string): number {
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  private cancelRefresh(key: string): void {
    clearTimeout(this.refreshes.get(key));
    this.refreshes.delete(key);
  }

  private scheduleRefresh(key: string, delay: number, emit: () => void): void {
    this.cancelRefresh(key);
    if (this.closed || this.presence.get(key) !== true) return;
    this.refreshes.set(key, setTimeout(() => {
      this.refreshes.delete(key);
      void this.fetch(key, emit);
    }, delay));
  }

  private cancelRemoval(key: string): void {
    const t = this.removals.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      this.removals.delete(key);
    }
  }

  private apply(key: string, payload: Uint8Array, emit: () => void): boolean {
    const parsed = parseLifecycleKey(key);
    const descriptor = parseLifecycleDescriptor(payload);
    if (!parsed || !descriptor) return false; // malformed → skip
    // Contract: `instance` MUST equal the key's <instance> segment (the probe rejects a mismatch too).
    if (descriptor.instance !== parsed.instance) return false;
    this.cancelRemoval(key);
    this.services.set(key, { key, ...parsed, descriptor, alive: true });
    emit();
    return true;
  }

  private async fetch(key: string, emit: () => void): Promise<void> {
    if (this.closed || this.presence.get(key) !== true || this.pending.has(key)) return;
    this.pending.add(key);
    const generation = this.generation(key);
    let applied = false;
    try {
      const [reply] = await this.transport.get(key, { timeoutMs: QUERY_TIMEOUT_MS });
      if (reply && !this.closed && this.presence.get(key) === true && this.generations.get(key) === generation)
        applied = this.apply(key, reply.payload, emit);
    } catch {
      // Only descriptor reads retry; lifecycle commands are never replayed here.
    } finally {
      this.pending.delete(key);
      // A publication may have already scheduled the next refresh while this query was pending.
      if (!this.refreshes.has(key)) this.scheduleRefresh(key, applied ? REFRESH_MS : RETRY_MS, emit);
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    for (const key of this.refreshes.keys()) this.cancelRefresh(key);
    for (const key of this.removals.keys()) this.cancelRemoval(key);
    this.services.clear();
    await Promise.allSettled(this.subs.splice(0).map((s) => s.close()));
  }
}
