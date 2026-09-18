import { useEffect, useState } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { useRosGraphContext } from "../ros/RosGraphContext";
import { callService } from "../services/callService";
import { bagPlayers, rosTimeInput, seekPlayer } from "../ros3d/playback";
import { decodedStream, playbackChange, selectTopic } from "../ros3d/runtime";
import { readReplayState, type ReplayState } from "../ros3d/replayState";
import type { RosbagPlaybackWidgetConfig } from "./rosbagSpec";
import "../ros3d/ros3d.css";

export default function RosbagPlaybackWidget({ widget }: { widget: RosbagPlaybackWidgetConfig }) {
  const { transport } = useTransportContext(); const { graph, resolver } = useRosGraphContext();
  const [player, select] = useState(widget.service ?? "");
  const domain = widget.domain_id ?? (graph.domains.length === 1 ? graph.domains[0] : undefined);
  const players = domain === undefined ? [] : bagPlayers(graph, domain);
  const base = player || (players.length === 1 ? players[0] : "");
  const [paused, setPaused] = useState<boolean>(); const [rate, setRate] = useState(1);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [seek, setSeek] = useState("");
  const [replay, setReplay] = useState<ReplayState>();
  const stateSignature = graph.topics.filter((t) => t.domainId === domain && t.name === (widget.state_topic ?? "/ros3d/replay_state"))
    .map((t) => `${t.dataKeyexpr}:${t.publishers.map((p) => p.keyexpr).sort().join(",")}`).join("|");
  useEffect(() => {
    setReplay(undefined);
    if (!transport || !resolver || domain === undefined) return;
    try {
      const topic = selectTopic(graph, widget.state_topic ?? "/ros3d/replay_state", domain, "std_msgs/msg/String");
      if (!topic) return;
      const stream = decodedStream(transport, resolver, topic, (m) => setReplay(readReplayState(m.data)), setError, true);
      return () => stream.close();
    } catch (e) { setError(String(e)); }
  }, [transport, resolver, domain, widget.state_topic, stateSignature]);
  const has = (op: string) => graph.services.some((s) => s.name === `${base}/${op}` && s.servers.some((p) => p.domainId === domain));
  useEffect(() => {
    if (!transport || !base || domain === undefined) return;
    let stopped = false; let pending = false;
    const poll = async () => {
      if (pending) return; pending = true;
      try {
        const replies = await Promise.all([
          callService(transport, graph, `${base}/is_paused`, {}, { domainId: domain }),
          callService(transport, graph, `${base}/get_rate`, {}, { domainId: domain }),
        ]);
        if (stopped) return;
        if (typeof replies[0].response.paused === "boolean") setPaused(replies[0].response.paused);
        if (typeof replies[1].response.rate === "number") { setRate(replies[1].response.rate); playbackChange(transport, domain, { rate: replies[1].response.rate }); }
      } catch (e) { if (!stopped) setError(String(e)); } finally { pending = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [transport, graph, base, domain]);
  const action = async (op: string, request: Record<string, unknown> = {}) => {
    if (!transport || !base || domain === undefined) return;
    setBusy(true); setError("");
    try {
      if (op === "seek" || op === "restart") await seekPlayer(transport, graph, base, domain,
        op === "restart" && replay ? { sec: Number(replay.begin / 1_000_000_000n), nanosec: Number(replay.begin % 1_000_000_000n) } : rosTimeInput(seek), () => playbackChange(transport, domain, { reset: true }));
      else {
        const result = await callService(transport, graph, `${base}/${op}`, request, { domainId: domain });
        if (result.response.success === false) throw new Error(`player rejected ${op}`);
        if (op === "pause") setPaused(true); if (op === "resume") setPaused(false);
        if (op === "set_rate") { setRate(Number(request.rate)); playbackChange(transport, domain, { rate: Number(request.rate) }); }
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return <div className="widget-card rosbag-playback"><span className="widget-label">{widget.label ?? "Replay controls"}</span><div className="ros3d-playback">
    <select aria-label="Bag player" value={base} onChange={(e) => { select(e.target.value); setError(""); }}>
      <option value="">{players.length ? "Choose player" : "No bag player advertised"}</option>
      {players.map((p) => <option key={p}>{p}</option>)}
    </select>
    {base && <>
      {has(paused ? "resume" : "pause") && <button className="btn" disabled={busy || paused === undefined} onClick={() => void action(paused ? "resume" : "pause")}>{paused ? "Resume" : "Pause"}</button>}
      {has("set_rate") && <select aria-label="Playback speed" value={rate} disabled={busy} onChange={(e) => void action("set_rate", { rate: Number(e.target.value) })}>
        {[...new Set([0.25, 0.5, 1, 2, 4, rate])].sort((a, b) => a - b).map((r) => <option key={r} value={r}>{r}×</option>)}
      </select>}
      {has("seek") && <>
        <input aria-label="Seek to ROS seconds" placeholder="ROS timestamp (seconds)" value={seek} onChange={(e) => setSeek(e.target.value)} />
        <button className="btn" disabled={busy || !seek || !has("pause") || !has("resume") || !has("is_paused")} onClick={() => void action("seek")}>Seek</button>
      </>}
      {replay?.player === base && <button className="btn" disabled={busy} onClick={() => void action("restart")}>Restart</button>}
      {has("set_loop") && <select aria-label="Playback loop" defaultValue="" disabled={busy} onChange={(e) => void action("set_loop", { data: e.target.value === "on" })}>
        <option value="" disabled>Set loop…</option><option value="on">Loop on</option><option value="off">Loop off</option>
      </select>}
    </>}
    {replay?.player === base && <span className="ros3d-playback-range">Bag {(Number(replay.begin) / 1e9).toFixed(3)}–{(Number(replay.end) / 1e9).toFixed(3)} s · TF snapshot ready</span>}
    {base && !replay && <span className="ros3d-playback-range">Native player: paused seeks need TF and cloud publication; use ros3d_replay for immediate previews.</span>}
    {error && <span className="ros3d-error" role="status">{error}</span>}
  </div></div>;
}
