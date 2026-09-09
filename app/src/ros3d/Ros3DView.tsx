import { useEffect, useMemo, useRef, useState } from "react";
import { useTransportContext } from "../transport/TransportContext";
import { useRosGraphContext } from "../ros/RosGraphContext";
import { loadChoice, saveChoice } from "../home/widgets/persist";
import { parseSceneOverrides, sceneConfig, type CloudDisplay, type Ros3DSceneConfig } from "./config";
import { ros3dRuntime } from "./runtime";
import { SceneModel } from "./sceneModel";
import { SceneRenderer, type CameraPose } from "./SceneRenderer";
import "./ros3d.css";

function validScene(value: unknown): value is Ros3DSceneConfig {
  try { parseSceneOverrides(value); return typeof value === "object" && value !== null; } catch { return false; }
}
function validPose(value: unknown): value is CameraPose {
  const p = value as CameraPose;
  return !!p && [p.position, p.target, p.origin].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) &&
    typeof p.ortho === "boolean" && Number.isFinite(p.zoom) && p.zoom > 0 && p.zoom < 1e6;
}
export interface Ros3DViewProps { initial: Ros3DSceneConfig; storageKey: string; compact?: boolean; active?: boolean; onExpand?: (config: Ros3DSceneConfig) => void }

export function Ros3DView(props: Ros3DViewProps) {
  return <ConfiguredView key={`${props.storageKey}.${JSON.stringify(props.initial)}`} {...props} />;
}

function ConfiguredView({ initial, storageKey, compact = false, active = true, onExpand }: Ros3DViewProps) {
  const { transport } = useTransportContext(); const { graph, resolver } = useRosGraphContext();
  // Config changes produce a distinct preference key, so a new YAML deployment is authoritative.
  const choiceKey = `${storageKey}.${JSON.stringify(initial)}`;
  const [config, setConfig] = useState(() => sceneConfig(initial, loadChoice(choiceKey, validScene)));
  const [model, setModel] = useState<SceneModel>(); const [graphicsError, setGraphicsError] = useState("");
  const [, refresh] = useState(0); const viewport = useRef<HTMLDivElement>(null); const renderer = useRef<SceneRenderer>();
  const [ortho, setOrtho] = useState(false); const [addTopic, setAddTopic] = useState("");
  const runtime = useMemo(() => transport && resolver ? ros3dRuntime(transport, resolver) : null, [transport, resolver]);
  const configRef = useRef(config); configRef.current = config;
  useEffect(() => { saveChoice(choiceKey, config); }, [choiceKey, config]);
  useEffect(() => {
    if (!runtime) { setModel(undefined); return; }
    const next = new SceneModel(runtime, configRef.current); setModel(next);
    return () => next.close();
  }, [runtime]);
  useEffect(() => { model?.configure(config, graph); }, [model, config, graph]);
  useEffect(() => {
    if (!model || !viewport.current) return;
    let view: SceneRenderer;
    try {
      const pose = loadChoice(`${choiceKey}.camera`, validPose);
      view = new SceneRenderer(viewport.current, model, setGraphicsError, pose); renderer.current = view;
      view.setVisible(active); view.setFollow(configRef.current.follow_frame); setOrtho(pose?.ortho ?? false); setGraphicsError("");
    } catch (e) { setGraphicsError(`Cannot start 3D graphics: ${String(e)}`); return; }
    const save = setInterval(() => saveChoice(`${choiceKey}.camera`, view.pose()), 2000);
    return () => { clearInterval(save); saveChoice(`${choiceKey}.camera`, view.pose()); view.dispose(); renderer.current = undefined; };
  }, [model, choiceKey]);
  useEffect(() => { renderer.current?.setVisible(active); }, [active]);
  useEffect(() => { renderer.current?.setFollow(config.follow_frame); }, [config.follow_frame]);
  useEffect(() => {
    const timer = setInterval(() => { model?.tick(); refresh((n) => n + 1); }, 200);
    return () => clearInterval(timer);
  }, [model]);

  const update = (patch: Partial<Ros3DSceneConfig>) => setConfig((old) => ({ ...old, ...patch }));
  const layerUpdate = (id: string, patch: Partial<CloudDisplay>) => update({ displays: config.displays.map((d) => d.id === id ? { ...d, ...patch } : d) });
  const frames = model?.source?.tf.names() ?? [];
  const domain = config.domain_id ?? (graph.domains.length === 1 ? graph.domains[0] : undefined);
  const topics = graph.topics.filter((t) => t.typeName === "sensor_msgs/msg/PointCloud2" && (domain === undefined || t.domainId === domain));
  const scans = [...(model?.layers.values() ?? [])].flatMap((l) => l.scans);
  const points = scans.reduce((n, s) => n + s.cloud.count, 0);
  const source = model?.source;
  const errors = [...(source?.errors.values() ?? []), ...(source?.tf.diagnostics() ?? [])];
  const clock = source?.time.stamp;
  const formatTime = (stamp: bigint) => `${stamp / 1_000_000_000n}.${(stamp % 1_000_000_000n).toString().padStart(9, "0").slice(0, 3)}`;

  return <div className={`ros3d-view${compact ? " ros3d-compact" : ""}`}>
    <div className="ros3d-toolbar">
      <label>Fixed frame <input aria-label="Fixed frame" list={`${storageKey}-frames`} value={config.fixed_frame} placeholder="Choose a frame" onChange={(e) => update({ fixed_frame: e.target.value })} /></label>
      <datalist id={`${storageKey}-frames`}>{frames.map((frame) => <option key={frame} value={frame} />)}</datalist>
      <button className="btn" onClick={() => renderer.current?.fit()} disabled={!points}>Fit</button>
      <button className="btn" onClick={() => renderer.current?.top()}>Top</button>
      <button className={`btn${ortho ? " active" : ""}`} aria-pressed={ortho} onClick={() => { setOrtho(!ortho); renderer.current?.setOrthographic(!ortho); }}>Ortho</button>
      <button className="btn" onClick={() => model?.clear()}>Clear scans</button>
      <label className="ros3d-check"><input type="checkbox" checked={config.show_grid} onChange={(e) => update({ show_grid: e.target.checked })} />Grid</label>
      <label className="ros3d-check"><input type="checkbox" checked={config.show_frames} onChange={(e) => update({ show_frames: e.target.checked })} />Frames</label>
      {onExpand && <button className="btn" onClick={() => onExpand(config)}>Open in 3D ↗</button>}
    </div>
    <div className="ros3d-body">
      <div className="ros3d-viewport" ref={viewport} aria-label="ROS point cloud viewport">
        {(!transport || !points || graphicsError) && <div className="ros3d-empty" role="status">
          <strong>{graphicsError || (!transport ? "Waiting for transport" : model?.error || (!config.fixed_frame ? "Choose a fixed frame to begin" : "Waiting for a transformable cloud"))}</strong>
          {!graphicsError && <span>{config.displays.map((d) => d.topic).join(" · ")}</span>}
        </div>}
        <div className="ros3d-viewport-status">{points.toLocaleString()} points · {scans.length} scan{scans.length === 1 ? "" : "s"} · {Math.round(renderer.current?.fps ?? 0)} FPS</div>
      </div>
      <details className="ros3d-sidebar" open={!compact}>
        <summary>Displays & settings</summary>
        <div className="ros3d-settings">
          <label>ROS domain <select aria-label="ROS domain" value={config.domain_id ?? "auto"} onChange={(e) => update({ domain_id: e.target.value === "auto" ? undefined : Number(e.target.value) })}>
            <option value="auto">{graph.domains.length === 1 ? `Auto (${graph.domains[0]})` : "Choose domain"}</option>
            {graph.domains.map((id) => <option key={id} value={id}>{id}</option>)}
          </select></label>
          <label>Time <select aria-label="Time source" value={config.time_source} onChange={(e) => update({ time_source: e.target.value as Ros3DSceneConfig["time_source"] })}>
            <option value="live">Live</option><option value="ros_clock">Playback / ROS clock</option>
          </select></label>
          <label>Follow frame <input aria-label="Follow frame" list={`${storageKey}-frames`} value={config.follow_frame} placeholder="None" onChange={(e) => update({ follow_frame: e.target.value })} /></label>
          {config.follow_frame && <button className="btn" onClick={() => renderer.current?.setFollow(config.follow_frame)}>Resume follow</button>}
          {config.displays.map((display) => {
            const layer = model?.layers.get(display.id); const latest = layer?.feed?.latest;
            const scalarNames = latest ? Object.keys(latest.scalars) : [];
            const scalar = display.color.field ?? "intensity";
            const missingColor = (["field", "intensity"].includes(display.color.mode) && latest && !latest.scalars[scalar]) ? `Missing color field: ${scalar}`
              : display.color.mode === "rgb" && latest && !latest.colors ? "No packed RGB/RGBA field" : "";
            const recent = layer?.feed?.lastArrival !== undefined && performance.now() - layer.feed.lastArrival <= 2000;
            const stale = config.time_source === "live" && layer?.feed?.lastArrival !== undefined && !recent;
            const colorValue = display.color.mode === "field" || display.color.mode === "intensity" ? `field:${scalar}` : display.color.mode;
            return <div className="ros3d-layer" key={display.id}>
              <div className="ros3d-layer-heading"><label><input type="checkbox" checked={display.enabled} onChange={(e) => layerUpdate(display.id, { enabled: e.target.checked })} />{display.topic}</label>
                <button className="btn" aria-label={`Remove ${display.topic}`} onClick={() => update({ displays: config.displays.filter((d) => d.id !== display.id) })}>×</button></div>
              <label>Color <select aria-label={`Color ${display.topic}`} value={colorValue} onChange={(e) => layerUpdate(display.id, { color: e.target.value.startsWith("field:") ? { mode: "field", field: e.target.value.slice(6) } : { mode: e.target.value as "flat" | "height" | "rgb", value: display.color.value } })}>
                <option value="height">Height in fixed frame</option><option value="flat">Flat color</option><option value="rgb">RGB / RGBA</option>
                {[...new Set(["intensity", ...scalarNames, ...(["field", "intensity"].includes(display.color.mode) ? [scalar] : [])])].map((f) => <option key={f} value={`field:${f}`}>{f}</option>)}
              </select></label>
              {display.color.mode === "flat" && <input type="color" aria-label={`Flat color ${display.topic}`} value={display.color.value ?? "#6ad5ed"} onChange={(e) => layerUpdate(display.id, { color: { mode: "flat", value: e.target.value } })} />}
              <label>Point size <input aria-label={`Point size ${display.topic}`} type="range" min="1" max="20" value={display.point_size} onChange={(e) => layerUpdate(display.id, { point_size: Number(e.target.value) })} /><span>{display.point_size} px</span></label>
              <label>Opacity <input aria-label={`Opacity ${display.topic}`} type="range" min="0" max="1" step="0.05" value={display.opacity} onChange={(e) => layerUpdate(display.id, { opacity: Number(e.target.value) })} /></label>
              <label>History <input aria-label={`History seconds ${display.topic}`} type="number" min="0" max="300" step="1" value={display.history_s} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 0 && n <= 300) layerUpdate(display.id, { history_s: n }); }} /><span>s · 0 = latest</span></label>
              <div className={`ros3d-layer-status${layer?.feed?.error || missingColor || layer?.status !== "ok" ? " warning" : ""}`} role="status">
                {layer?.feed?.error || missingColor || (stale ? "stale — no recent samples" : layer?.status) || "waiting"}
              </div>
              <small>{latest?.frame ? `${latest.frame} → ${config.fixed_frame || "?"} · ` : ""}{(recent ? layer?.feed?.hz ?? 0 : 0).toFixed(1)} Hz · {(layer?.dropped ?? 0) + (layer?.feed?.dropped ?? 0)} dropped · {layer?.pending.length ?? 0} waiting</small>
              {layer?.feed?.warning && <small className="warning">{layer.feed.warning}</small>}
            </div>;
          })}
          <div className="ros3d-add"><select aria-label="Add cloud topic" value={addTopic} onChange={(e) => setAddTopic(e.target.value)}>
            <option value="">Add a cloud topic…</option>{[...new Set(topics.map((t) => t.name))].map((name) => <option key={name}>{name}</option>)}
          </select><button className="btn" disabled={!addTopic || config.displays.length >= 16} onClick={() => { update({ displays: [...config.displays, { id: `${addTopic}-${Date.now()}`, topic: addTopic, enabled: true, color: { mode: "height" }, point_size: 2, opacity: 1, history_s: 0 }] }); setAddTopic(""); }}>Add</button></div>
          <details><summary>TF diagnostics · {frames.length} frames</summary>
            {errors.map((e, i) => <p className="ros3d-error" key={i}>{e}</p>)}
            <table><thead><tr><th>Parent → child</th><th>History</th></tr></thead><tbody>{source?.tf.frames().map((f) => <tr key={f.child}><td>{f.parent} → {f.child}</td><td>{f.static ? "static" : `${f.samples} samples`}</td></tr>)}</tbody></table>
            <button className="btn" onClick={() => source?.reset("TF reset", false)}>Reload transforms</button>
          </details>
        </div>
      </details>
    </div>
    <div className="ros3d-footer"><span>{config.time_source === "ros_clock" ? clock === undefined ? "Waiting for /clock" : `ROS time ${formatTime(clock)}` : "Live"}</span>
      <span>{source?.time.reason === "waiting for clock" && config.time_source === "live" ? "" : source?.time.reason}</span>
      <span>{(scans.reduce((n, s) => n + s.cloud.bytes, 0) / 1024 / 1024).toFixed(1)} MiB point data · bounded to {config.max_points.toLocaleString()} points</span></div>
    {config.time_source === "ros_clock" && <div className="ros3d-playback-status">
      {source?.replay ? `Replay: ${source.replay.player} · TF snapshot available` : "Following external ROS playback time"}
    </div>}
  </div>;
}
