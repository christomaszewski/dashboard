import type { Subscription, Transport } from "../transport/types";
import { parseDescriptor, type DiscoveredStream } from "./types";

const MEDIA_PATTERN = "fleet/*/media/*";

/**
 * Discovers media streams via the fleet convention (docs/DISCOVERY.md): a liveliness subscriber on
 * the media pattern gives presence (PUT = appeared, DELETE = gone); on PUT we `get` the same key for
 * the JSON descriptor. The liveliness subscriber is declared with history, so already-live streams
 * arrive as PUTs too — no separate cold-start query needed. (Pattern: fleet, vehicle, media, sensor.)
 */
export class StreamDiscovery {
  private sub: Subscription | null = null;
  private readonly streams = new Map<string, DiscoveredStream>();

  constructor(
    private readonly transport: Transport,
    private readonly pattern: string = MEDIA_PATTERN,
  ) {}

  async start(onChange: (streams: DiscoveredStream[]) => void): Promise<void> {
    const emit = () =>
      onChange([...this.streams.values()].sort((a, b) => a.key.localeCompare(b.key)));

    this.sub = await this.transport.liveliness.subscribe(this.pattern, (e) => {
      if (!e.alive) {
        if (this.streams.delete(e.keyexpr)) emit();
        return;
      }
      void this.fetch(e.keyexpr, emit);
    });
  }

  private async fetch(key: string, emit: () => void): Promise<void> {
    try {
      const [reply] = await this.transport.get(key);
      if (!reply) return;
      const descriptor = parseDescriptor(reply.payload);
      if (!descriptor) return; // malformed → skip
      const parts = key.split("/"); // fleet / <vehicle> / media / <sensor>
      this.streams.set(key, { key, vehicleId: parts[1] ?? "", sensorId: parts[3] ?? "", descriptor });
      emit();
    } catch {
      // best-effort discovery; a failed descriptor fetch just omits the stream
    }
  }

  async stop(): Promise<void> {
    await this.sub?.close();
    this.sub = null;
    this.streams.clear();
  }
}
