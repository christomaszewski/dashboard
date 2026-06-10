// The fleet media-discovery descriptor, per gige-vision-service docs/DISCOVERY.md (the source of truth).
// Required: schema_version, id, producer, protocol, signalling, producer_id. The rest are best-effort.
export interface StreamDescriptor {
  schema_version: number;
  id: string;
  producer: string;
  protocol: string; // "gstwebrtc-api" | "whep" | ...
  signalling: string; // ws(s)://host:port the producer serves
  producer_id: string; // selector on the signalling server == webrtcsink meta.name
  role?: string;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  pixel_format?: string;
  ros_topic?: string;
  recording?: string;
}

export interface DiscoveredStream {
  key: string; // fleet/<vehicle>/media/<sensor>
  vehicleId: string;
  sensorId: string;
  descriptor: StreamDescriptor;
  /** false = liveliness token currently dropped; the entry is held for a grace period (producer
   *  restarts withdraw + re-advertise, e.g. the webrtc-bridge cycling) so tiles don't unmount. */
  alive: boolean;
}

const REQUIRED: (keyof StreamDescriptor)[] = [
  "schema_version",
  "id",
  "producer",
  "protocol",
  "signalling",
  "producer_id",
];

/** Parse + validate a queryable's JSON descriptor reply. Returns null if malformed (skip the stream). */
export function parseDescriptor(bytes: Uint8Array): StreamDescriptor | null {
  try {
    const obj: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof obj !== "object" || obj === null) return null;
    const d = obj as Record<string, unknown>;
    for (const field of REQUIRED) {
      if (!(field in d)) return null;
    }
    return d as unknown as StreamDescriptor;
  } catch {
    return null;
  }
}
