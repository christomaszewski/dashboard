import type { Subscription, Transport } from "../transport/types";
import { PLAYBACK_PATTERN, PLAYBACK_STATE_PATTERN, parsePlaybackDescriptor, parsePlaybackKey, type PlaybackService } from "./types";

/** Same grace as the lifecycle: a producer restart withdraws + re-advertises within seconds. */
export const PLAYBACK_OFFLINE_GRACE_MS = 45_000;

/**
 * Discovers playback-controllable services (docs/PLAYBACK.md): a history-backed liveliness
 * subscriber on the playback pattern gives presence; on PUT we `get` the descriptor; every
 * `state` publication (each change, ~1 Hz position while playing) updates it — no polling. The
 * mirror of LifecycleDiscovery on the sibling keyspace.
 */
export class PlaybackDiscovery {
  private tokenSub: Subscription | null = null;
  private stateSub: Subscription | null = null;
  private readonly services = new Map<string, PlaybackService>();
  private readonly removals = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly transport: Transport,
    private readonly graceMs: number = PLAYBACK_OFFLINE_GRACE_MS,
  ) {}

  async start(onChange: (services: PlaybackService[]) => void): Promise<void> {
    const emit = () => onChange([...this.services.values()].sort((a, b) => a.key.localeCompare(b.key)));

    this.tokenSub = await this.transport.liveliness.subscribe(PLAYBACK_PATTERN, (e) => {
      if (!parsePlaybackKey(e.keyexpr)) return;
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

    this.stateSub = await this.transport.subscribe(PLAYBACK_STATE_PATTERN, (s) => {
      if (s.kind !== "put") return;
      this.apply(s.keyexpr.replace(/\/state$/, ""), s.payload, emit);
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
    const parsed = parsePlaybackKey(key);
    const descriptor = parsePlaybackDescriptor(payload);
    if (!parsed || !descriptor) return;
    if (descriptor.instance !== parsed.instance) return; // contract: instance == the key segment
    this.services.set(key, { key, ...parsed, descriptor, alive: true });
    emit();
  }

  private async fetch(key: string, emit: () => void): Promise<void> {
    try {
      const [reply] = await this.transport.get(key);
      if (reply) this.apply(key, reply.payload, emit);
    } catch {
      // best-effort; the next publication fills it in
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
