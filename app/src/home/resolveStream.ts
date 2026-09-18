import type { DiscoveredStream } from "../streams/types";

// Resolve a home-config stream reference against discovery: sensor id (the last segment of the
// media key) first, then the descriptor's `id`, then the full keyexpr. Single-vehicle assumption,
// same as signalling.ts — a fleet deployment would need a vehicle-qualified reference.
export function resolveStreamRef(streams: DiscoveredStream[], ref: string): DiscoveredStream | undefined {
  return (
    streams.find((s) => s.sensorId === ref) ??
    streams.find((s) => s.descriptor.id === ref) ??
    streams.find((s) => s.key === ref)
  );
}
