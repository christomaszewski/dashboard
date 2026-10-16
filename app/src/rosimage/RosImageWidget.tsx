import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRosGraphContext } from "../ros/RosGraphContext";
import type { TopicEntry } from "../ros/graph";
import { useTransportContext } from "../transport/TransportContext";
import { useTabActive } from "../shell/TabActivity";
import { useNow } from "../health/useHealth";
import { imagePixels } from "./pixels";
import type { RosImageWidgetConfig } from "./spec";

export const ROS_IMAGE_TYPE = "sensor_msgs/msg/Image";

/** Select by exact domain and type. Never silently pick one of several same-name publishers. */
export function selectImageTopic(topics: TopicEntry[], name: string, domain?: number): TopicEntry | undefined {
  const matches = topics.filter((t) => t.name === name && t.typeName === ROS_IMAGE_TYPE &&
    (domain === undefined || t.domainId === domain));
  return matches.length === 1 ? matches[0] : undefined;
}

function ImageView({ topic, name, normalize, staleAfterS, active }: {
  topic?: TopicEntry; name: string; normalize: boolean; staleAfterS: number; active: boolean;
}) {
  const { store } = useRosGraphContext();
  const { status } = useTransportContext();
  const key = active ? topic?.dataKeyexpr : undefined;
  const typeName = topic?.typeName, typeHash = topic?.typeHash, transientLocal = topic?.transientLocal ?? false;
  useEffect(() => {
    if (!store || !key || !typeName || !typeHash) return;
    const handle = store.acquire({ dataKeyexpr: key, typeName, typeHash, transientLocal });
    return () => handle.release();
  }, [store, key, typeName, typeHash, transientLocal]);
  const subscribe = useCallback((cb: () => void) => store && key ? store.subscribe(key, cb) : () => {}, [store, key]);
  const snapshot = useSyncExternalStore(subscribe, useCallback(() => store && key ? store.getSnapshot(key) : null, [store, key]));
  const [received, setReceived] = useState<{ message: Record<string, unknown>; at: number; key: string }>();
  useEffect(() => {
    if (snapshot?.message && key) setReceived((old) => old && old.message === snapshot.message && old.key === key ? old : { message: snapshot.message!, at: Date.now(), key });
  }, [snapshot?.message, key]);
  const observation = received && (!key || received.key === key) ? received : undefined;
  const converted = useMemo(() => {
    if (!observation) return {};
    try { return { pixels: imagePixels(observation.message, normalize) }; }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }, [observation, normalize]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [paintError, setPaintError] = useState("");
  useEffect(() => {
    const el = canvas.current, frame = converted.pixels;
    if (!el || !frame) return;
    try {
      el.width = frame.width; el.height = frame.height;
      const ctx = el.getContext("2d");
      if (!ctx) throw new Error("Canvas rendering is unavailable");
      const image = ctx.createImageData(frame.width, frame.height);
      image.data.set(frame.rgba); ctx.putImageData(image, 0, 0); setPaintError("");
    } catch (e) { setPaintError(e instanceof Error ? e.message : String(e)); }
  }, [converted.pixels]);
  const now = useNow();
  const age = observation ? Math.max(0, (now - observation.at) / 1000) : undefined;
  const error = converted.error || paintError || snapshot?.error;
  const live = active && status === "connected" && !!topic?.publishers.length && !error && age !== undefined && age < staleAfterS;
  return <>
    <div className="ros-image-status" role="status">
      <span className={`pill ${error ? "err" : live ? "ok" : "idle"}`}>{error ? "image error" : live ? "live" : observation ? "last frame" : "waiting"}</span>
      <span className="dim">{observation ? `${Math.floor(age!)} s since frame` : `Waiting for ${name}`}</span>
      {converted.pixels && <span className="dim mono">{converted.pixels.width} × {converted.pixels.height} · {converted.pixels.encoding}</span>}
      {status !== "connected" && <span className="dim">Updates {status}</span>}
    </div>
    {error && <p className="error-box" role="alert">{error}</p>}
    {snapshot?.warning && <p className="dim widget-sub">{snapshot.warning}</p>}
    <div className="ros-image-frame">
      <canvas ref={canvas} hidden={!converted.pixels || !!paintError} role="img" aria-label={`ROS image from ${name}${live ? "" : " (last received frame)"}`} />
      {!converted.pixels && <span className="dim">{error ? "No displayable image" : "Waiting for image data…"}</span>}
    </div>
  </>;
}

export default function RosImageWidget({ widget }: { widget: RosImageWidgetConfig }) {
  // Changing configured defaults resets local topic/domain selection.
  return <ImageWidget key={JSON.stringify([widget.topic, widget.topics, widget.domain_id, widget.normalize])} widget={widget} />;
}

function ImageWidget({ widget }: { widget: RosImageWidgetConfig }) {
  const { graph } = useRosGraphContext();
  const active = useTabActive();
  const [name, setName] = useState(widget.topic);
  const [domain, setDomain] = useState(widget.domain_id);
  const [normalize, setNormalize] = useState(widget.normalize);
  const images = graph.topics.filter((t) => t.typeName === ROS_IMAGE_TYPE && (!widget.topics || widget.topics.includes(t.name)));
  const names = [...new Set([widget.topic, ...(widget.topics ?? images.map((t) => t.name)), name])];
  const domains = [...new Set(images.filter((t) => t.name === name).map((t) => t.domainId))].sort((a, b) => a - b);
  if (domain !== undefined && !domains.includes(domain)) domains.push(domain);
  const selected = selectImageTopic(images, name, domain);
  const ambiguous = !selected && images.filter((t) => t.name === name && (domain === undefined || t.domainId === domain)).length > 1;
  const wrongTypes = graph.topics.filter((t) => t.name === name && t.typeName !== ROS_IMAGE_TYPE && (domain === undefined || t.domainId === domain));
  const label = widget.label ?? "ROS image";
  return <div className="widget-card widget-ros-image">
    <div className="ros-image-heading">
      <span className="widget-label">{label}</span>
      <label>Image <select aria-label={`Image topic for ${label}`} value={name} onChange={(e) => setName(e.target.value)}>
        {names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select></label>
      {(domains.length > 1 || widget.domain_id !== undefined) && <label>Domain <select aria-label={`ROS domain for ${label}`}
        value={domain ?? ""} onChange={(e) => setDomain(e.target.value === "" ? undefined : Number(e.target.value))}>
        <option value="">Auto</option>{domains.map((d) => <option key={d} value={d}>{d}</option>)}
      </select></label>}
      <label><input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} /> Auto contrast</label>
    </div>
    {ambiguous && <p className="warn-box">{domain === undefined && domains.length > 1 ? "Choose a ROS domain for this image topic." : "Multiple image schemas are advertised for this topic in the same domain."}</p>}
    {!selected && wrongTypes.length > 0 && <p className="error-box" role="alert">Expected {ROS_IMAGE_TYPE}; this topic advertises {wrongTypes.map((t) => t.typeName).join(", ")}.</p>}
    <ImageView key={`${name}:${domain ?? "auto"}`} topic={selected} name={name}
      active={active && !ambiguous} normalize={normalize} staleAfterS={widget.stale_after_s} />
  </div>;
}
