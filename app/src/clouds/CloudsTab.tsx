import { useEffect, useRef, useState, type DragEvent } from "react";
import { PointCloudViewer, type ColorSpec, type ViewPreset } from "./vendor/core/PointCloudViewer";
import { BASEMAPS, type BasemapId } from "./vendor/core/BasemapLayer";
import type { ColormapName } from "./vendor/core/colormaps";
import { supportedExtensions } from "./vendor/loaders";
import { useCloudLoader } from "./useCloudLoader";
import { CloudsList } from "./CloudsList";

const VIEW_PRESETS: { view: ViewPreset; label: string; title: string }[] = [
  { view: "north", label: "N", title: "look from the north" },
  { view: "east", label: "E", title: "look from the east" },
  { view: "south", label: "S", title: "look from the south" },
  { view: "west", label: "W", title: "look from the west" },
  { view: "top", label: "Top", title: "top-down" },
  { view: "fit", label: "Fit", title: "fit the cloud" },
];

const EXTS = supportedExtensions().map((e) => `.${e}`);

/**
 * Point-cloud viewer tab: React chrome over the vendored framework-free viewer core (see
 * vendor/VENDORED.md). Drag & drop is scoped to THIS tab's root — dropping a file on other tabs
 * does nothing. Clouds come from drops, the Open… picker, the vehicle's /clouds/ listing (when
 * mounted), or a ?cloud=<url> query param.
 */
export default function CloudsTab() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PointCloudViewer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { state, loadBuffer, loadUrl } = useCloudLoader();

  const [colorValue, setColorValue] = useState("height"); // "height" | "attr:<name>" | "flat"
  const [colormap, setColormap] = useState<ColormapName>("viridis");
  const [pointSize, setPointSize] = useState(2);
  const [attenuate, setAttenuate] = useState(true);
  const [ortho, setOrtho] = useState(false);
  const [grid, setGrid] = useState(true);
  const [basemap, setBasemap] = useState<BasemapId | "none">("none");
  const [basemapError, setBasemapError] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  // Viewer lifetime == tab mount (the Shell keeps this tab mounted once visited).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const viewer = new PointCloudViewer(el);
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // ?cloud=<url> on first mount (relative URLs resolve against the app origin).
  useEffect(() => {
    const url = new URLSearchParams(window.location.search).get("cloud");
    if (url) void loadUrl(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cloud = state.phase === "ready" ? state.cloud : null;

  // New cloud → hand to the viewer, reset color to height (matches upstream behavior).
  useEffect(() => {
    if (!cloud || !viewerRef.current) return;
    viewerRef.current.setPointCloud(cloud);
    setColorValue("height");
    setColormap("viridis");
    setBasemapError("");
  }, [cloud]);

  // Control effects — each maps one piece of React state onto the viewer.
  useEffect(() => {
    if (!cloud || !viewerRef.current) return;
    let spec: ColorSpec;
    if (colorValue === "height") spec = { mode: "height" };
    else if (colorValue === "flat") spec = { mode: "flat" };
    else spec = { mode: "attribute", name: colorValue.slice("attr:".length) };
    viewerRef.current.setColor(spec, colormap);
  }, [cloud, colorValue, colormap]);
  useEffect(() => viewerRef.current?.setPointSize(pointSize), [pointSize]);
  useEffect(() => viewerRef.current?.setAttenuation(attenuate), [attenuate]);
  useEffect(() => viewerRef.current?.setProjection(ortho ? "orthographic" : "perspective"), [ortho]);
  useEffect(() => viewerRef.current?.setGridVisible(grid), [grid]);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    setBasemapError("");
    if (basemap !== "none" && viewer.canShowBasemap()) {
      // Imagery under the grid is just noise.
      setGrid(false);
      viewer.setGridVisible(false);
      let warned = false;
      viewer.setBasemap(basemap, () => {
        if (!warned) setBasemapError("Some map tiles failed to load (offline, or zoom not covered here).");
        warned = true;
      });
    } else {
      viewer.setBasemap(null);
    }
  }, [cloud, basemap]);

  const onColorChange = (value: string) => {
    // Auto-pick the classification palette for classification-ish attributes.
    const name = value.startsWith("attr:") ? value.slice(5) : "";
    if (/class/i.test(name)) setColormap("classification");
    else if (colormap === "classification") setColormap("viridis");
    setColorValue(value);
  };

  // Tab-scoped drag & drop.
  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    if (++dragDepth.current === 1) setDragging(true);
  };
  const onDragLeave = () => {
    if (--dragDepth.current === 0) setDragging(false);
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) loadBuffer(file.name, await file.arrayBuffer());
  };

  const canBasemap = cloud !== null && (viewerRef.current?.canShowBasemap() ?? false);
  const dims = (cloud?.source.dimensions as string[] | undefined)?.join(", ") ?? "";

  return (
    <section
      className="card clouds-tab"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="card-header clouds-toolbar">
        <h2>Clouds</h2>
        <button className="btn" onClick={() => fileInputRef.current?.click()}>
          Open…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={EXTS.join(",")}
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) loadBuffer(file.name, await file.arrayBuffer());
            e.target.value = "";
          }}
        />
        <label className="clouds-control">
          color
          <select className="field" value={colorValue} disabled={!cloud} onChange={(e) => onColorChange(e.target.value)}>
            <option value="height">Height (Z)</option>
            {cloud?.attributes.map((a) => (
              <option key={a.name} value={`attr:${a.name}`}>
                {a.name}
              </option>
            ))}
            <option value="flat">Single color</option>
          </select>
        </label>
        <label className="clouds-control">
          map
          <select
            className="field"
            value={colormap}
            disabled={!cloud}
            onChange={(e) => setColormap(e.target.value as ColormapName)}
          >
            <option value="viridis">viridis</option>
            <option value="rainbow">rainbow</option>
            <option value="grayscale">grayscale</option>
            <option value="classification">classification</option>
          </select>
        </label>
        <label className="clouds-control" title="point size (px)">
          size
          <input
            type="range"
            min={1}
            max={8}
            step={0.5}
            value={pointSize}
            onChange={(e) => setPointSize(parseFloat(e.target.value))}
          />
        </label>
        <label className="clouds-check">
          <input type="checkbox" checked={attenuate} onChange={(e) => setAttenuate(e.target.checked)} />
          Perspective size
        </label>
        <label className="clouds-check" title="parallel projection — best for side and top views">
          <input type="checkbox" checked={ortho} onChange={(e) => setOrtho(e.target.checked)} />
          Ortho
        </label>
        <label className="clouds-check">
          <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} />
          Grid
        </label>
        <label className="clouds-control" title="georeferenced basemap (tiles fetched by this browser)">
          base
          <select
            className="field"
            value={basemap}
            disabled={!canBasemap}
            onChange={(e) => setBasemap(e.target.value as BasemapId | "none")}
          >
            <option value="none">none</option>
            {(Object.keys(BASEMAPS) as BasemapId[]).map((id) => (
              <option key={id} value={id}>
                {BASEMAPS[id].label}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <div className="clouds-views" role="group" aria-label="view presets">
          {VIEW_PRESETS.map((p) => (
            <button key={p.view} className="btn" title={p.title} disabled={!cloud} onClick={() => viewerRef.current?.setView(p.view)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="clouds-viewport" ref={viewportRef}>
        {state.phase === "idle" && (
          <div className="clouds-overlay">
            <p className="empty">
              Drop a point cloud here, or Open… ({EXTS.join(", ")})
            </p>
            <CloudsList onOpen={(url) => void loadUrl(url)} />
          </div>
        )}
        {state.phase === "loading" && (
          <div className="clouds-overlay">
            <p className="empty">{state.message}</p>
          </div>
        )}
        {dragging && (
          <div className="clouds-overlay clouds-drop">
            <span>Drop to load</span>
          </div>
        )}
        {basemap !== "none" && canBasemap && (
          <span className="clouds-attribution">{BASEMAPS[basemap as BasemapId].attribution}</span>
        )}
      </div>

      <div className="clouds-status">
        {state.phase === "ready" && (
          <span className="dim mono">
            {state.name} · {state.cloud.count.toLocaleString()} points
            {state.cloud.crs ? ` · ${state.cloud.crs}` : ""}
            {dims ? ` · dims: ${dims}` : ""} · parsed in {state.parseMs.toFixed(0)} ms
          </span>
        )}
        {state.phase === "error" && <span className="mono clouds-error">{state.message}</span>}
        {basemapError && <span className="mono clouds-error"> {basemapError}</span>}
      </div>
    </section>
  );
}
