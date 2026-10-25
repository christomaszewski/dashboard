// A health service on the wire (vehicle state "health" items). The vehicle's own HealthDiscovery
// assembles services; timestamps mean nothing on another machine, so the wire carries ages instead:
// how long ago, at reply time, the vehicle received the service and each status. The browser turns
// them back into its own clock, and every staleness rule keeps working unchanged.
import type { HealthService, HealthSnapshot, HealthStatus } from "../health/types";

type WireStatus = Omit<HealthStatus, "receivedAtMs" | "receivedMonoMs">;
type WireService = Omit<HealthService, "receivedAtMs" | "receivedMonoMs" | "snapshot"> & {
  snapshot: Omit<HealthSnapshot, "status"> & { status: WireStatus[] };
};

export interface HealthWire {
  /** Bumped by the vehicle each time it re-assembles the service (a new sample, a liveness change). */
  c: number;
  s: WireService;
  /** At reply time: ms since the vehicle received the service, and each status (null = unknown). */
  age?: number;
  sa?: (number | null)[];
}

/** The part that changes only with the service itself — what decides whether to send it again. */
export function healthToWire(service: HealthService, counter: number): HealthWire {
  const { receivedAtMs: _a, receivedMonoMs: _m, snapshot, ...rest } = service;
  void _a; void _m;
  const status = snapshot.status.map(({ receivedAtMs: _sa, receivedMonoMs: _sm, ...s }) => { void _sa; void _sm; return s; });
  return { c: counter, s: { ...rest, snapshot: { ...snapshot, status } } };
}

/** Ages at reply time, from the vehicle's clocks. */
export function healthAges(service: HealthService, nowMs: number, nowMono: number): Pick<HealthWire, "age" | "sa"> {
  const ageOf = (mono?: number, at?: number) =>
    mono !== undefined ? Math.max(0, Math.round(nowMono - mono)) : at !== undefined ? Math.max(0, Math.round(nowMs - at)) : null;
  return {
    age: ageOf(service.receivedMonoMs, service.receivedAtMs) ?? 0,
    sa: service.snapshot.status.map((s) => ageOf(s.receivedMonoMs, s.receivedAtMs)),
  };
}

/** Back to a HealthService on this machine's clocks. */
export function healthFromWire(wire: HealthWire, nowMs = Date.now(), nowMono = performance.now()): HealthService {
  const age = wire.age ?? 0;
  const status: HealthStatus[] = wire.s.snapshot.status.map((s, i) => {
    const a = wire.sa?.[i];
    return a === null || a === undefined ? { ...s } : { ...s, receivedAtMs: nowMs - a, receivedMonoMs: nowMono - a };
  });
  return { ...wire.s, snapshot: { ...wire.s.snapshot, status }, receivedAtMs: nowMs - age, receivedMonoMs: nowMono - age };
}
