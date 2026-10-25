import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRosGraphContext } from "../ros/RosGraphContext";
import type { TopicEntry } from "../ros/graph";
import { useTransportContext } from "../transport/TransportContext";
import { useTabActive } from "../shell/TabActivity";
import { useNow } from "../health/useHealth";
import { TopicSourceCtx, useVehicleState } from "../vstate/VehicleStateContext";
import { useVehicleFrame } from "../vstate/useVehicleFrame";
import { publisherTypeQuery, useLivelinessGraph } from "../ros/useLivelinessGraph";
import { imagePixels } from "./pixels";
import type { RosImageWidgetConfig } from "./spec";

export const ROS_IMAGE_TYPE = "sensor_msgs/msg/Image";
export const ROS_COMPRESSED_IMAGE_TYPE = "sensor_msgs/msg/CompressedImage";
const IMAGE_TYPES = [ROS_IMAGE_TYPE, ROS_COMPRESSED_IMAGE_TYPE];
const isImageType = (typeName: string) => IMAGE_TYPES.includes(typeName);

/** Select by exact domain and type. Never silently pick one of several same-name publishers. */
export function selectImageTopic(topics: TopicEntry[], name: string, domain?: number): TopicEntry | undefined {
  const matches = topics.filter((t) => t.name === name && isImageType(t.typeName) &&
    (domain === undefined || t.domainId === domain));
  return matches.length === 1 ? matches[0] : undefined;
}

function ImageView({ topic, name, normalize, staleAfterS, active }: {
  topic?: TopicEntry; name: string; normalize: boolean; staleAfterS: number; active: boolean;
}) {
  // Only the store: the parent widget holds the graph subscription when it picks a raw topic.
  const { store } = useRosGraphContext(false);
  const { status } = useTransportContext();
  const key = active ? topic?.dataKeyexpr : undefined;
  const typeName = topic?.typeName, typeHash = topic?.typeHash, transientLocal = topic?.transientLocal ?? false;
  useEffect(() => {
    if (!store || !key || !topic) return;
    const handle = store.acquire(topic);
    return () => handle.release();
    // The announcement updates the graph too; depend on topic identity, not graph object identity.
  }, [store, key, typeName, typeHash, transientLocal]);
  const subscribe = useCallback((cb: () => void) => store && key ? store.subscribe(key, cb) : () => {}, [store, key]);
  const snapshot = useSyncExternalStore(subscribe, useCallback(() => store && key ? store.getSnapshot(key) : null, [store, key]));
  const [received, setReceived] = useState<{ message: Record<string, unknown>; at: number; key: string }>();
  useEffect(() => {
    if (snapshot?.message && key) setReceived((old) => old && old.message === snapshot.message && old.key === key ? old : { message: snapshot.message!, at: Date.now(), key });
  }, [snapshot?.message, key]);
  const observation = received && (!key || received.key === key) ? received : undefined;
  // sensor_msgs/CompressedImage: the browser decodes JPEG/PNG itself.
  const compressed = observation && typeof observation.message.format === "string" ? observation.message : undefined;
  const converted = useMemo(() => {
    if (!observation || compressed) return {};
    try { return { pixels: imagePixels(observation.message, normalize) }; }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }, [observation, compressed, normalize]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [paintError, setPaintError] = useState("");
  const [shown, setShown] = useState<{ width: number; height: number; encoding: string }>();
  useEffect(() => {
    const el = canvas.current, frame = converted.pixels;
    if (!el || !frame) return;
    try {
      el.width = frame.width; el.height = frame.height;
      const ctx = el.getContext("2d");
      if (!ctx) throw new Error("Canvas rendering is unavailable");
      const image = ctx.createImageData(frame.width, frame.height);
      image.data.set(frame.rgba); ctx.putImageData(image, 0, 0); setPaintError("");
      setShown({ width: frame.width, height: frame.height, encoding: frame.encoding });
    } catch (e) { setPaintError(e instanceof Error ? e.message : String(e)); }
  }, [converted.pixels]);
  useEffect(() => {
    const el = canvas.current;
    if (!el || !compressed) return;
    const data = compressed.data;
    if (!(data instanceof Uint8Array)) { setPaintError("Invalid compressed image data"); return; }
    let cancelled = false;
    createImageBitmap(new Blob([data as BlobPart])).then((bitmap) => {
      if (cancelled) return bitmap.close();
      el.width = bitmap.width; el.height = bitmap.height;
      const ctx = el.getContext("2d");
      if (!ctx) throw new Error("Canvas rendering is unavailable");
      ctx.drawImage(bitmap, 0, 0); bitmap.close(); setPaintError("");
      setShown({ width: el.width, height: el.height, encoding: String(compressed.format) });
    }).catch((e) => { if (!cancelled) setPaintError(`Could not decode ${String(compressed.format)} image: ${e instanceof Error ? e.message : String(e)}`); });
    return () => { cancelled = true; };
  }, [compressed]);
  const now = useNow();
  const age = observation ? Math.max(0, (now - observation.at) / 1000) : undefined;
  const error = converted.error || paintError || snapshot?.error;
  const painted = !!shown && !!observation && !converted.error;
  const live = active && status === "connected" && !!topic?.publishers.length && !error && age !== undefined && age < staleAfterS;
  return <>
    <div className="ros-image-status" role="status">
      <span className={`pill ${error ? "err" : live ? "ok" : "idle"}`}>{error ? "image error" : live ? "live" : observation ? "last frame" : "waiting"}</span>
      <span className="dim">{observation ? `${Math.floor(age!)} s since frame` : `Waiting for ${name}`}</span>
      {painted && <span className="dim mono">{shown.width} × {shown.height} · {shown.encoding}</span>}
      {status !== "connected" && <span className="dim">Updates {status}</span>}
    </div>
    {error && <p className="error-box" role="alert">{error}</p>}
    {snapshot?.warning && <p className="dim widget-sub">{snapshot.warning}</p>}
    <div className="ros-image-frame">
      <canvas ref={canvas} hidden={!painted || !!paintError} role="img" aria-label={`ROS image from ${name}${live ? "" : " (last received frame)"}`} />
      {!painted && <span className="dim">{error ? "No displayable image" : "Waiting for image data…"}</span>}
    </div>
  </>;
}

/** Frames the vehicle downscales and compresses for the link (docs/VEHICLE_STATE.md, "Images"). */
function VehicleImageView({ widget, name, normalize, active }: {
  widget: RosImageWidgetConfig; name: string; normalize: boolean; active: boolean;
}) {
  const { status } = useTransportContext();
  const frame = useVehicleFrame(name, {
    maxHz: widget.max_hz, maxWidth: widget.max_width, quality: widget.quality, format: widget.format, normalize,
  }, active);
  const now = useNow();
  const h = frame.header;
  // Age on screen: how old the frame was when the vehicle sent it, plus the time since it arrived.
  const age = frame.receivedAt !== undefined ? Math.max(0, (now - frame.receivedAt + (h?.age ?? 0)) / 1000) : undefined;
  const error = frame.unavailable ?? frame.error;
  const advertised = !h || h.t !== undefined;
  const live = active && status === "connected" && !frame.link && !error && !h?.s && age !== undefined && age < widget.stale_after_s;
  const pill = error ? "image error" : live ? "live" : frame.url ? "last frame" : "waiting";
  const detail = h?.w !== undefined
    ? `${h.w} × ${h.h}${h.sw ? ` of ${h.sw} × ${h.sh}` : ""} · ${h.enc ?? ""} · ${Math.round((frame.bytes ?? 0) / 1024)} KB`
    : undefined;
  return <>
    <div className="ros-image-status" role="status">
      <span className={`pill ${error ? "err" : live ? "ok" : "idle"}`}>{pill}</span>
      <span className="dim">{frame.url ? `${Math.floor(age!)} s since frame` : advertised ? `Waiting for ${name}` : `${name} is not advertised on the vehicle`}</span>
      {detail && <span className="dim mono">{detail}</span>}
      {frame.level > 0 && <span className="dim">reduced for the link</span>}
      {h?.s && <span className="dim">stale on the vehicle</span>}
      {(frame.link || status !== "connected") && <span className="dim">Updates {status === "connected" ? "reconnecting" : status}</span>}
    </div>
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="ros-image-frame">
      {frame.url && <img src={frame.url} alt={`ROS image from ${name}${live ? "" : " (last received frame)"}`} />}
      {!frame.url && <span className="dim">{error ? "No displayable image" : "Waiting for image data…"}</span>}
    </div>
  </>;
}

export default function RosImageWidget({ widget }: { widget: RosImageWidgetConfig }) {
  // Changing configured defaults resets local topic/domain selection.
  return <ImageWidget key={JSON.stringify([widget.topic, widget.topics, widget.domain_id, widget.normalize])} widget={widget} />;
}

// With vehicle state the picker lists image publishers found by type, not from the whole graph.
const IMAGE_QUERIES = [publisherTypeQuery("sensor_msgs::msg::dds_::Image_"), publisherTypeQuery("sensor_msgs::msg::dds_::CompressedImage_")];

function ImageWidget({ widget }: { widget: RosImageWidgetConfig }) {
  const active = useTabActive();
  const source = useContext(TopicSourceCtx);
  const { enabled } = useVehicleState();
  const onVehicle = source === "vehicle" && enabled;
  const { graph: full } = useRosGraphContext(!onVehicle);
  const images_ = useLivelinessGraph(onVehicle ? IMAGE_QUERIES : null);
  const graph = onVehicle ? images_ : full;
  const [name, setName] = useState(widget.topic);
  const [domain, setDomain] = useState(widget.domain_id);
  const [normalize, setNormalize] = useState(widget.normalize);
  const images = graph.topics.filter((t) => isImageType(t.typeName) && (!widget.topics || widget.topics.includes(t.name)));
  const names = [...new Set([widget.topic, ...(widget.topics ?? images.map((t) => t.name)), name])];
  const domains = [...new Set(images.filter((t) => t.name === name).map((t) => t.domainId))].sort((a, b) => a - b);
  if (domain !== undefined && !domains.includes(domain)) domains.push(domain);
  const selected = selectImageTopic(images, name, domain);
  const ambiguous = !selected && images.filter((t) => t.name === name && (domain === undefined || t.domainId === domain)).length > 1;
  const wrongTypes = graph.topics.filter((t) => t.name === name && !isImageType(t.typeName) && (domain === undefined || t.domainId === domain));
  const label = widget.label ?? "ROS image";
  return <div className="widget-card widget-ros-image">
    <div className="ros-image-heading">
      <span className="widget-label">{label}</span>
      <label>Image <select aria-label={`Image topic for ${label}`} value={name} onChange={(e) => setName(e.target.value)}>
        {names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select></label>
      {!onVehicle && (domains.length > 1 || widget.domain_id !== undefined) && <label>Domain <select aria-label={`ROS domain for ${label}`}
        value={domain ?? ""} onChange={(e) => setDomain(e.target.value === "" ? undefined : Number(e.target.value))}>
        <option value="">Auto</option>{domains.map((d) => <option key={d} value={d}>{d}</option>)}
      </select></label>}
      <label><input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} /> Auto contrast</label>
    </div>
    {!onVehicle && ambiguous && <p className="warn-box">{domain === undefined && domains.length > 1 ? "Choose a ROS domain for this image topic." : "Multiple image schemas are advertised for this topic in the same domain."}</p>}
    {!selected && wrongTypes.length > 0 && <p className="error-box" role="alert">Expected {ROS_IMAGE_TYPE} or {ROS_COMPRESSED_IMAGE_TYPE}; this topic advertises {wrongTypes.map((t) => t.typeName).join(", ")}.</p>}
    {onVehicle
      ? <VehicleImageView key={name} widget={widget} name={name} normalize={normalize} active={active && wrongTypes.length === 0} />
      : <ImageView key={`${name}:${domain ?? "auto"}`} topic={selected} name={name}
          active={active && !ambiguous} normalize={normalize} staleAfterS={widget.stale_after_s} />}
  </div>;
}
