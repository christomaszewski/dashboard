import type { StreamDescriptor } from "../types";
import type { StreamSource, StreamSourceFactory } from "./types";
import { GstWebRtcSource } from "./gstwebrtc";

// Keyed by the descriptor's `protocol`. Add "whep" etc. here as more producers ship.
const FACTORIES: Record<string, StreamSourceFactory> = {
  "gstwebrtc-api": (d) => new GstWebRtcSource(d),
};

export function createSource(descriptor: StreamDescriptor): StreamSource {
  const make = FACTORIES[descriptor.protocol];
  if (!make) throw new Error(`unsupported stream protocol: '${descriptor.protocol}'`);
  return make(descriptor);
}
