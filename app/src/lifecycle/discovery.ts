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

/**
 * Discovers lifecycle-controlled services (camera-service recorders today; the key convention is
 * service-agnostic). Presence = liveliness on `fleet/*\/svc/*\/lifecycle` (history-backed, so
 * already-running services arrive as PUTs); on PUT we `get` the same key for the JSON descriptor.
 * Live state changes arrive on the `…/state` publications, so a transition made by anyone (this
 * dashboard, another operator, a SIGUSR from a shell) updates every viewer without polling.
 */
export class LifecycleDiscovery {
  private tokenSub: Subscription | null = null;
  private stateSub: Subscription | null = null;
  private readonly services = new Map<string, LifecycleService>();
  private readonly removals = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly transport: Transport,
    private readonly graceMs: number = LIFECYCLE_OFFLINE_GRACE_MS,
  ) {}

  async start(onChange: (services: LifecycleService[]) => void): Promise<void> {
    const emit = () =>
      onChange([...this.services.values()].sort((a, b) => a.key.localeCompare(b.key)));

    this.tokenSub = await this.transport.liveliness.subscribe(LIFECYCLE_PATTERN, (e) => {
      if (!parseLifecycleKey(e.keyexpr)) return;
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
    });

    // Descriptor publications on every transition. A publication for a key we have not seen yet
    // (missed token, or the token still landing) creates the entry — the descriptor is the same.
    this.stateSub = await this.transport.subscribe(LIFECYCLE_STATE_PATTERN, (s) => {
      if (s.kind !== "put") return;
      const key = s.keyexpr.replace(/\/state$/, "");
      this.apply(key, s.payload, emit);
    });
  }

  private cancelRemoval(key: string): void {
    const t = this.removals.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      this.removals.delete(key);
    }
  }

  private apply(key: string, payload: Uint8Array, emit: () => void): void {
    const parsed = parseLifecycleKey(key);
    const descriptor = parseLifecycleDescriptor(payload);
    if (!parsed || !descriptor) return; // malformed → skip
    // Contract: `instance` MUST equal the key's <instance> segment (the probe rejects a mismatch too).
    if (descriptor.instance !== parsed.instance) return;
    this.services.set(key, { key, ...parsed, descriptor, alive: true });
    emit();
  }

  private async fetch(key: string, emit: () => void): Promise<void> {
    try {
      const [reply] = await this.transport.get(key);
      if (reply) this.apply(key, reply.payload, emit);
    } catch {
      // best-effort; a failed descriptor fetch just omits the service until its next publication
    }
  }

  async stop(): Promise<void> {
    await this.tokenSub?.close();
    await this.stateSub?.close();
    this.tokenSub = null;
    this.stateSub = null;
    for (const key of this.removals.keys()) this.cancelRemoval(key);
    this.services.clear();
  }
}
