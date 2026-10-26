import { createContext, useContext } from "react";
import { formatValue } from "../home/value";
import { useTransportContext } from "../transport/TransportContext";
import { HealthCtx } from "./HealthContext";
import { HealthTooltip } from "./HealthTooltip";
import { useNow } from "./useHealth";
import {
  STRENGTH_WORDS, barsLevel, interferenceLevel, isRadioService, radioLink, radioSelected,
  type RadioLink, type RadioOptions,
} from "./radioLink";
import type { HealthService } from "./types";

/** The instance's `health.radio` options, for the header indicator and the health summary. */
export const RadioOptionsCtx = createContext<RadioOptions | undefined>(undefined);
export const useRadioOptions = () => useContext(RadioOptionsCtx);

const num = (n: number | undefined, unit: string, digits = 0) =>
  n === undefined ? null : `${formatValue(n, Number.isInteger(n) ? 0 : digits)}${unit.startsWith("%") ? "" : " "}${unit}`;

/** One line for the link: "good (4/4)", "no peers in range", "RF off", … */
export function radioHeadline(link: RadioLink, options?: RadioOptions): string {
  if (link.rfOff) return "RF off";
  if (link.missingPeer) return `peer ${options?.peer} not heard`;
  if (link.bars === null) return link.interference ? "link strength not reported" : "no link report";
  if (!link.peer) return "no peers in range";
  return `${STRENGTH_WORDS[link.bars]} (${link.bars}/4)`;
}

/** The value the bars were drawn from: "28 dB SNR", "−62 dBm", "75% quality". */
export function strengthValue(link: RadioLink): string | null {
  if (!link.peer || link.basis === null) return null;
  if (link.basis === "snr") return num(link.snrDb, "dB SNR");
  if (link.basis === "signal") return num(link.peer.signalDbm, "dBm");
  return num(link.peer.qualityPct, "% quality");
}

export function interferenceValue(link: RadioLink): string | null {
  const parts = [link.noiseLevel && num(link.noiseDbm, "dBm noise"), link.busyLevel && num(link.busyPct, "% busy")];
  return parts.filter(Boolean).join(", ") || null;
}

export function SignalBars({ bars, level }: { bars: number | null; level: string }) {
  const heights = [4, 7, 10, 13];
  return <svg className={`radio-bars ${level}`} viewBox="0 0 19 14" aria-hidden>
    {heights.map((h, i) => <rect key={i} x={i * 5} y={14 - h} width="3.4" height={h} rx="0.8"
      className={bars !== null && i < bars ? "on" : "off"} />)}
  </svg>;
}

function InterferenceMark({ level }: { level: string }) {
  return <svg className={`radio-interference ${level}`} viewBox="0 0 14 12" aria-hidden>
    <path d="M1 4 q3 -3.4 6 0 t6 0 M1 9 q3 -3.4 6 0 t6 0" fill="none" />
  </svg>;
}

/** Everything behind the indicator: the chosen peer, its measurements, noise, busy time, power. */
export function RadioDetail({ service, link, options, connected }: {
  service: HealthService; link: RadioLink; options?: RadioOptions; connected: boolean;
}) {
  const peer = link.peer;
  const rows: [string, string | null][] = [
    ["Signal", num(peer?.signalDbm, "dBm")],
    ["SNR", num(link.snrDb, "dB") && `${num(link.snrDb, "dB")}${peer?.snrDb === undefined ? " (signal − noise)" : ""}`],
    ["Link quality", num(peer?.qualityPct, "%")],
    ["Packet loss", num(peer?.lossPct, "%", 1)],
    ["Rate", num(peer?.rateMbps, "Mbit/s", 1)],
    ["Noise floor", num(link.noiseDbm, "dBm", 1) && `${num(link.noiseDbm, "dBm", 1)}${link.noisePeakDbm !== undefined ? ` (peak ${num(link.noisePeakDbm, "dBm", 1)})` : ""}`],
    ["Channel busy", num(link.busyPct, "%")],
    ["Interference", link.interference],
    ["TX power", link.rfOff ? "RF off" : num(link.txPowerDbm, "dBm")],
    ["Peers", link.stations !== undefined || link.meshNodes !== undefined
      ? [link.stations !== undefined && `${link.stations} station(s)`, link.meshNodes !== undefined && `${link.meshNodes} mesh node(s)`].filter(Boolean).join(", ")
      : link.peers.length > 0 ? String(link.peers.length) : null],
  ];
  return <>
    <strong>{service.instance} · {radioHeadline(link, options)}</strong>
    {peer && <p>{link.chosen === "configured" ? "Configured peer" : `Strongest of ${link.peers.length} peer${link.peers.length === 1 ? "" : "s"}`}{" "}
      <span className="mono">{peer.id}</span>
      {link.basis && ` · bars from ${link.basis === "snr" ? "SNR" : link.basis === "signal" ? "signal strength" : "link quality"}`}</p>}
    {link.missingPeer && <p>The configured peer is not in the radio&apos;s latest link report.</p>}
    <dl className="health-values mono">{rows.filter(([, v]) => v !== null && v !== "").map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    {!connected ? <p className="health-note warn">Dashboard disconnected: these are the last values received.</p>
      : !link.current && <p className="health-note warn">Last known: the radio&apos;s report is not current.</p>}
    <span className="health-tooltip-source">{service.vehicleId} · {service.sourceLabel ?? "Zenoh JSON"}<br />{service.key}</span>
  </>;
}

function RadioIndicator({ service, options, nowMs, connected, named }: {
  service: HealthService; options?: RadioOptions; nowMs: number; connected: boolean; named: boolean;
}) {
  const link = radioLink(service, nowMs, options, connected);
  if (!link) return null;
  const level = barsLevel(link);
  const noisy = link.interference === "moderate" || link.interference === "high";
  const label = `${service.instance} radio: ${radioHeadline(link, options)}${strengthValue(link) ? `, ${strengthValue(link)}` : ""}` +
    `${noisy ? `, ${link.interference} interference` : ""}${link.current ? "" : ", last known"}`;
  return <HealthTooltip className={`radio-indicator ${level}${link.current ? "" : " stale"}`} label={label}
    detail={<RadioDetail service={service} link={link} options={options} connected={connected} />}>
    <SignalBars bars={link.bars} level={level} />
    {noisy && <InterferenceMark level={link.current ? interferenceLevel(link.interference) : "idle"} />}
    {named && <span className="radio-name">{service.instance}</span>}
  </HealthTooltip>;
}

/** Header: one small indicator per radio reporter (at most three); nothing when there is none. */
export function RadioIndicators() {
  const health = useContext(HealthCtx);
  const options = useRadioOptions();
  const { status } = useTransportContext();
  const nowMs = useNow();
  if (!health || options?.header === false) return null;
  const radios = health.services.filter((s) => isRadioService(s) && radioSelected(s, options?.services)).slice(0, 3);
  if (radios.length === 0) return null;
  return <span className="radio-indicators">{radios.map((s) => <RadioIndicator key={s.key} service={s} options={options}
    nowMs={nowMs} connected={status === "connected"} named={radios.length > 1} />)}</span>;
}
