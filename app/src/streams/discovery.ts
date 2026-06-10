import type { Subscription, Transport } from "../transport/types";
import { parseDescriptor, type DiscoveredStream } from "./types";

const MEDIA_PATTERN = "fleet/*/media/*";

/** How long a stream survives a dropped liveliness token before its tile is removed. Producer
 *  restarts (webrtc-bridge cycling after a core rebuild) withdraw + re-advertise within seconds;
 *  unmounting tiles on every flap kills active playback and loses the operator's play intent. */
export const OFFLINE_GRACE_MS = 45_000;

/**
 * Discovers media streams via the fleet convention (docs/DISCOVERY.md): a liveliness subscriber on
 * the media pattern gives presence (PUT = appeared, DELETE = gone); on PUT we `get` the same key for
 * the JSON descriptor. The liveliness subscriber is declared with history, so already-live streams
 * arrive as PUTs too — no separate cold-start query needed.
 *
 * A DELETE marks the stream offline (alive=false) and only removes it after OFFLINE_GRACE_MS; a
 * re-PUT inside the grace refreshes the descriptor (ports/geometry may have changed across a
 * producer restart) and flips it back alive.
 */
export class StreamDiscovery {
  private sub: Subscription | null = null;
  private readonly streams = new Map<string, DiscoveredStream>();
  private readonly removals = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly transport: Transport,
    private readonly pattern: string = MEDIA_PATTERN,
    private readonly graceMs: number = OFFLINE_GRACE_MS,
  ) {}

  async start(onChange: (streams: DiscoveredStream[]) => void): Promise<void> {
    const emit = () =>
      onChange([...this.streams.values()].sort((a, b) => a.key.localeCompare(b.key)));

    this.sub = await this.transport.liveliness.subscribe(this.pattern, (e) => {
      if (!e.alive) {
        const entry = this.streams.get(e.keyexpr);
        if (!entry) return;
        this.streams.set(e.keyexpr, { ...entry, alive: false });
        this.cancelRemoval(e.keyexpr);
        this.removals.set(
          e.keyexpr,
          setTimeout(() => {
            this.removals.delete(e.keyexpr);
            if (this.streams.get(e.keyexpr)?.alive === false) {
              this.streams.delete(e.keyexpr);
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
  }

  private cancelRemoval(key: string): void {
    const t = this.removals.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      this.removals.delete(key);
    }
  }

  private async fetch(key: string, emit: () => void): Promise<void> {
    try {
      const [reply] = await this.transport.get(key);
      if (!reply) return;
      const descriptor = parseDescriptor(reply.payload);
      if (!descriptor) return; // malformed → skip
      const parts = key.split("/"); // fleet / <vehicle> / media / <sensor>
      this.streams.set(key, {
        key,
        vehicleId: parts[1] ?? "",
        sensorId: parts[3] ?? "",
        descriptor,
        alive: true,
      });
      emit();
    } catch {
      // best-effort discovery; a failed descriptor fetch just omits the stream
    }
  }

  async stop(): Promise<void> {
    await this.sub?.close();
    this.sub = null;
    for (const key of this.removals.keys()) this.cancelRemoval(key);
    this.streams.clear();
  }
}
