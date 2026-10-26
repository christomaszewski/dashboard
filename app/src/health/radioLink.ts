// Link strength and interference from a radio's health report (docs/SERVICE_HEALTH.md, "Radio
// keys" and "Link quality keys"). Pure: the header indicator and the health summary both use it.
//
// Strength comes from the peer that carries the link: the configured one, else the strongest peer
// currently in the radio's report. Producers publish vendor-neutral `link.*` / `mesh.*` keys on
// `link/<peer>` / `mesh/<peer>` components (or one summary on `links`); until they do, a few common
// vendor names are read too (`rssi`, `signal`, BATMAN `tq`). Interference is the radio's noise floor
// and channel busy time. ROS diagnostics carry every value as a string, so numbers are parsed here.
import { componentOf, reporterCurrent, statusCurrent, type HealthService, type HealthStatus, type HealthValue } from "./types";

export interface RadioThresholds {
  /** Bars 1–4 at or above each value. */
  snr_db: number[];
  signal_dbm: number[];
  quality_pct: number[];
  /** Interference moderate above the first value, high above the second. */
  noise_dbm: number[];
  busy_pct: number[];
}

export const RADIO_DEFAULTS: RadioThresholds = {
  snr_db: [5, 12, 20, 30],
  signal_dbm: [-90, -80, -70, -60],
  quality_pct: [20, 40, 60, 80],
  noise_dbm: [-88, -80],
  busy_pct: [50, 80],
};

export interface RadioOptions extends Partial<RadioThresholds> {
  /** Radio reporters to show (`instance` or `vehicle/instance`); omit = every radio reporter. */
  services?: string[];
  /** The peer that carries the operator link (an address as the radio reports it). */
  peer?: string;
  /** Show the header indicator (default true). */
  header?: boolean;
}

export type Interference = "low" | "moderate" | "high";
export type StrengthBasis = "snr" | "signal" | "quality";

export interface RadioPeer {
  id: string;
  kind: "link" | "mesh" | "links";
  present: boolean;
  signalDbm?: number;
  snrDb?: number;
  qualityPct?: number;
  lossPct?: number;
  rateMbps?: number;
  status: HealthStatus;
}

export interface RadioLink {
  /** Peers in the latest report, the chosen one first. */
  peers: RadioPeer[];
  /** The peer the bars describe; null when none is in the report. */
  peer: RadioPeer | null;
  /** How the peer was chosen. */
  chosen: "configured" | "strongest" | null;
  /** A peer is configured and it is not in the radio's report: the operator link is not heard. */
  missingPeer: boolean;
  /** 0–4, or null when the radio reports nothing to judge strength by. */
  bars: number | null;
  basis: StrengthBasis | null;
  /** The chosen peer's SNR: reported, or its signal minus the noise floor. */
  snrDb?: number;
  noiseDbm?: number;
  noisePeakDbm?: number;
  busyPct?: number;
  noiseLevel: Interference | null;
  busyLevel: Interference | null;
  interference: Interference | null;
  rfOff: boolean;
  txPowerDbm?: number;
  stations?: number;
  meshNodes?: number;
  /** Every observation used is fresh, from a live reporter, over a connected dashboard. */
  current: boolean;
}

/** A finite number, from a number or a numeric string (ROS diagnostics); booleans are not numbers. */
export function radioNumber(value: HealthValue | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !/^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?\s*$/i.test(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const inRange = (n: number | undefined, lo: number, hi: number) => (n !== undefined && n >= lo && n <= hi ? n : undefined);
const first = (values: Record<string, HealthValue>, keys: string[], lo: number, hi: number) => {
  for (const key of keys) {
    const n = inRange(radioNumber(values[key]), lo, hi);
    if (n !== undefined) return n;
  }
  return undefined;
};
const falsy = (v: HealthValue | undefined) => v === false || (typeof v === "string" && v.trim().toLowerCase() === "false");

function peerValues(kind: RadioPeer["kind"], values: Record<string, HealthValue>) {
  const k = (s: string) => `${kind}.${s}`;
  const tq = inRange(radioNumber(values[k("tq")]), 0, 255);
  return {
    signalDbm: first(values, [k("signal_dbm"), k("rssi_dbm"), k("rssi"), k("signal")], -130, 0),
    snrDb: first(values, [k("snr_db"), k("snr")], -30, 90),
    qualityPct: first(values, [k("quality_pct")], 0, 100) ?? (tq === undefined ? undefined : Math.round((tq / 255) * 100)),
    lossPct: first(values, [k("loss_pct")], 0, 100),
    rateMbps: first(values, [k("rate_mbps")], 0, 1e5),
  };
}

const hasPrefix = (status: HealthStatus, prefixes: string[]) => Object.keys(status.values).some((key) => prefixes.some((p) => key.startsWith(p)));

/** A radio reporter: radio-level `rf.*` / `links.*` values, or per-peer link components. */
export function isRadioService(service: HealthService): boolean {
  return service.snapshot.status.some((s) => {
    const c = componentOf(s, service.instance);
    return c === "radio" || c === "links" || /^(?:link|mesh)\//.test(c) || hasPrefix(s, ["rf.", "links."]);
  });
}

/** Matches `instance` or `vehicle/instance`, like widget service references. */
export function radioSelected(service: HealthService, refs: readonly string[] | undefined): boolean {
  if (!refs) return true;
  return refs.some((ref) => ref === service.instance || ref === `${service.vehicleId}/${service.instance}`);
}

function bandsAbove(value: number, limits: number[]): Interference {
  return value > limits[1] ? "high" : value > limits[0] ? "moderate" : "low";
}
const RANK: Record<Interference, number> = { low: 0, moderate: 1, high: 2 };

export function radioLink(service: HealthService, nowMs: number, options: RadioOptions = {}, connected = true): RadioLink | null {
  if (!isRadioService(service)) return null;
  const t: RadioThresholds = { ...RADIO_DEFAULTS, ...options };
  const statuses = service.snapshot.status;
  const component = (s: HealthStatus) => componentOf(s, service.instance);
  const rf = statuses.find((s) => component(s) === "radio") ?? statuses.find((s) => hasPrefix(s, ["rf.noise", "rf.channel_activity"]));
  const links = statuses.find((s) => component(s) === "links");

  const peers: RadioPeer[] = [];
  for (const status of statuses) {
    const m = /^(link|mesh)\/(.+)$/.exec(component(status));
    if (!m) continue;
    const kind = m[1] as "link" | "mesh";
    const present = !falsy(status.values[`${kind}.present`]) && statusCurrent(service, status, nowMs);
    peers.push({ id: m[2], kind, present, status, ...peerValues(kind, status.values) });
  }
  // A radio that reports one link (or the operator's) as a summary on `links`.
  if (links) {
    const summary = peerValues("links", links.values);
    if (summary.signalDbm !== undefined || summary.snrDb !== undefined || summary.qualityPct !== undefined) {
      peers.push({ id: String(links.values["links.peer"] ?? "link"), kind: "links", present: statusCurrent(service, links, nowMs), status: links, ...summary });
    }
  }

  const noiseDbm = inRange(radioNumber(rf?.values["rf.noise_dbm"]), -150, 0);
  const noisePeakDbm = inRange(radioNumber(rf?.values["rf.noise_peak_dbm"]), -150, 0);
  const busyPct = inRange(radioNumber(rf?.values["rf.channel_activity_pct"]), 0, 100);
  const snrOf = (p: RadioPeer) => p.snrDb ?? (p.signalDbm !== undefined && noiseDbm !== undefined ? p.signalDbm - noiseDbm : undefined);
  const score = (p: RadioPeer): [number, number, number] => [snrOf(p) ?? -Infinity, p.signalDbm ?? -Infinity, p.qualityPct ?? -Infinity];

  const live = peers.filter((p) => p.present);
  const wanted = options.peer?.trim().toLowerCase();
  const configured = wanted ? live.find((p) => p.id.toLowerCase() === wanted) : undefined;
  const strongest = [...live].sort((a, b) => {
    const [x, y] = [score(a), score(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  })[0];
  // A configured peer that is not heard is no link, even when other mesh nodes are.
  const peer = wanted ? configured ?? null : strongest ?? null;
  const chosen = configured ? "configured" : peer ? "strongest" : null;
  const missingPeer = wanted !== undefined && wanted !== "" && !configured;

  const rfOff = typeof rf?.values["rf.state"] === "string" && rf.values["rf.state"].trim().toLowerCase() === "off";
  const snrDb = peer ? snrOf(peer) : undefined;
  let bars: number | null = null;
  let basis: StrengthBasis | null = null;
  const count = (value: number, limits: number[]) => limits.filter((l) => value >= l).length;
  if (peer && !rfOff) {
    if (snrDb !== undefined) [bars, basis] = [count(snrDb, t.snr_db), "snr"];
    else if (peer.signalDbm !== undefined) [bars, basis] = [count(peer.signalDbm, t.signal_dbm), "signal"];
    else if (peer.qualityPct !== undefined) [bars, basis] = [count(peer.qualityPct, t.quality_pct), "quality"];
  } else if (rfOff || missingPeer || links || peers.length > 0) {
    bars = 0; // the radio reports its links and none carries one (or its transmitter is off)
  }

  const noiseLevel = noiseDbm === undefined ? null : bandsAbove(noiseDbm, t.noise_dbm);
  const busyLevel = busyPct === undefined ? null : bandsAbove(busyPct, t.busy_pct);
  const levels = [noiseLevel, busyLevel].filter((l): l is Interference => l !== null);
  const interference = levels.length === 0 ? null : levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));

  const used = [rf, links, peer?.status].filter((s): s is HealthStatus => s !== undefined);
  const current = connected && reporterCurrent(service, nowMs) &&
    used.every((s) => statusCurrent(service, s, nowMs) && s.values["health.availability"] !== "retrying");

  return {
    peers: peer ? [peer, ...live.filter((p) => p !== peer)] : live,
    peer, chosen, missingPeer, bars, basis, snrDb,
    noiseDbm, noisePeakDbm, busyPct, noiseLevel, busyLevel, interference,
    rfOff,
    txPowerDbm: inRange(radioNumber(rf?.values["rf.tx_power_dbm"]), -50, 60),
    stations: inRange(radioNumber(links?.values["links.stations"]), 0, 1e6),
    meshNodes: inRange(radioNumber(links?.values["links.mesh_nodes"]), 0, 1e6),
    current,
  };
}

export const STRENGTH_WORDS = ["very weak", "weak", "fair", "good", "excellent"] as const;

/** ok / warn / err for the bars (idle when not current). */
export function barsLevel(link: RadioLink): "ok" | "warn" | "err" | "idle" {
  if (!link.current || link.bars === null) return "idle";
  return link.bars >= 3 ? "ok" : link.bars === 2 ? "warn" : "err";
}

export function interferenceLevel(level: Interference | null): "ok" | "warn" | "err" | "idle" {
  return level === null ? "idle" : level === "high" ? "err" : level === "moderate" ? "warn" : "ok";
}
