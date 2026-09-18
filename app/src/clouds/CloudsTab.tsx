import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  PointCloudViewer,
  type BlendMode,
  type ColorScale,
  type ColorSpec,
  type ViewPreset,
} from "./vendor/core/PointCloudViewer";
import { BASEMAPS, type BasemapId } from "./vendor/core/BasemapLayer";
import { colormapData, type ColormapName } from "./vendor/core/colormaps";
import { supportedExtensions } from "./vendor/loaders";
import { useCloudLoader } from "./useCloudLoader";
import { CloudsList } from "./CloudsList";
import { RunClouds } from "./RunClouds";

const VIEW_PRESETS: { view: ViewPreset; label: string; title: string }[] = [
  { view: "north", label: "N", title: "look from the north" },
  { view: "east", label: "E", title: "look from the east" },
  { view: "south", label: "S", title: "look from the south" },
  { view: "west", label: "W", title: "look from the west" },
  { view: "top", label: "Top", title: "top-down" },
  { view: "fit", label: "Fit", title: "fit the cloud" },
];

const EXTS = supportedExtensions().map((e) => `.${e}`);

/** Legend numbers with a precision that suits the scale's span. */
const fmt = (v: number, span: number) => v.toFixed(span >= 1000 ? 0 : span >= 100 ? 1 : 2);

/**
 * Point-cloud viewer tab: React chrome over the vendored framework-free viewer core (see
 * vendor/VENDORED.md). Drag & drop is scoped to THIS tab's root — dropping a file on other tabs
 * does nothing. Clouds come from drops, the Open… picker, the vehicle's /clouds/ listing (when
 * mounted), the rig run registry (Runs…, any file in a supported format under /rig-data/runs/),
 * or a ?cloud=<url> query param.
 */
export default function CloudsTab() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PointCloudViewer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { state, loadBuffer, loadUrl } = useCloudLoader();

  const [colorValue, setColorValue] = useState("height"); // "height" | "attr:<name>" | "flat"
  const [colormap, setColormap] = useState<ColormapName>("viridis");
  const [alphaValue, setAlphaValue] = useState("none"); // "none" | "attr:<name>"
  const [alphaFloor, setAlphaFloor] = useState(0.1);
  const [blend, setBlend] = useState<BlendMode>("normal");
  const [opacity, setOpacity] = useState(1);
  const [edl, setEdl] = useState(true);
  const [edlStrength, setEdlStrength] = useState(1);
  const [pointSize, setPointSize] = useState(2);
  const [attenuate, setAttenuate] = useState(true);
  const [ortho, setOrtho] = useState(false);
  const [grid, setGrid] = useState(true);
  const [basemap, setBasemap] = useState<BasemapId | "none">("none");
  const [basemapError, setBasemapError] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [showRuns, setShowRuns] = useState(false); // the run-registry browser panel (Runs…)

  // The active color scale (pull API on the viewer) mirrored into state for the legend. `nonce`
  // forces the legend's uncontrolled number inputs to re-init after a rejected edit.
  const [scale, setScale] = useState<ColorScale | null>(null);
  const [nonce, setNonce] = useState(0);
  const legendRef = useRef<HTMLCanvasElement>(null);
  const minRef = useRef<HTMLInputElement>(null);
  const maxRef = useRef<HTMLInputElement>(null);
  const refreshScale = useCallback(() => setScale(viewerRef.current?.getColorScale() ?? null), []);

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

  // New cloud → hand to the viewer; color and alpha reset (matches upstream), the rest persists.
  useEffect(() => {
    if (!cloud || !viewerRef.current) return;
    viewerRef.current.setPointCloud(cloud);
    setColorValue("height");
    setColormap("viridis");
    setAlphaValue("none");
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
    refreshScale();
  }, [cloud, colorValue, colormap, refreshScale]);
  useEffect(() => {
    if (!cloud || !viewerRef.current) return;
    const on = alphaValue.startsWith("attr:");
    viewerRef.current.setAlpha(
      on ? { mode: "attribute", name: alphaValue.slice("attr:".length), floor: alphaFloor } : { mode: "none" },
    );
  }, [cloud, alphaValue, alphaFloor]);
  useEffect(() => viewerRef.current?.setOpacity(opacity), [opacity]);
  useEffect(() => viewerRef.current?.setBlending(blend), [blend]);
  useEffect(() => viewerRef.current?.setEdl(edl), [edl]);
  useEffect(() => viewerRef.current?.setEdlStrength(edlStrength), [edlStrength]);
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

  // Legend ramp: bake the gamma in so the bar shows the mapping as applied.
  useEffect(() => {
    const ctx = legendRef.current?.getContext("2d");
    if (!ctx || !scale) return;
    const src = colormapData(scale.map);
    const img = ctx.createImageData(256, 1);
    for (let i = 0; i < 256; i++) {
      const j = Math.round(Math.pow(i / 255, scale.gamma) * 255) * 4;
      img.data.set(src.subarray(j, j + 4), i * 4);
    }
    ctx.putImageData(img, 0, 0);
  }, [scale]);

  const onColorChange = (value: string) => {
    // Auto-pick the classification palette for classification-ish attributes.
    const name = value.startsWith("attr:") ? value.slice(5) : "";
    if (/class/i.test(name)) setColormap("classification");
    else if (colormap === "classification") setColormap("viridis");
    setColorValue(value);
  };

  const applyRange = () => {
    const lo = parseFloat(minRef.current?.value ?? "");
    const hi = parseFloat(maxRef.current?.value ?? "");
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) viewerRef.current?.setColorRange([lo, hi]);
    refreshScale();
    setNonce((n) => n + 1); // also reverts a rejected edit
  };
  const onRangeKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur(); // blur commits via onBlur
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
  const alphaOn = alphaValue.startsWith("attr:");
  const dims = (cloud?.source.dimensions as string[] | undefined)?.join(", ") ?? "";
  const showLegend = cloud !== null && scale !== null && scale.map !== "classification";
  const span = scale ? scale.max - scale.min : 0;

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
        <button className="btn" onClick={() => setShowRuns((s) => !s)} aria-pressed={showRuns} title="browse the rig run registry for point clouds">
          Runs…
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
        <span className="clouds-sep" />
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
        <label className="clouds-control" title="per-point opacity from an attribute — intensity brings out surface texture">
          alpha
          <select className="field" value={alphaValue} disabled={!cloud} onChange={(e) => setAlphaValue(e.target.value)}>
            <option value="none">None</option>
            {cloud?.attributes.map((a) => (
              <option key={a.name} value={`attr:${a.name}`}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="clouds-control" title="opacity of the weakest points — raise it so they don't vanish">
          min
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={alphaFloor}
            disabled={!alphaOn}
            onChange={(e) => setAlphaFloor(parseFloat(e.target.value))}
          />
        </label>
        <label
          className="clouds-control"
          title="Normal: dim by alpha, near points still occlude. Translucent: see-through. Additive: sums contributions, dense areas glow"
        >
          blend
          <select
            className="field"
            value={blend}
            disabled={!(alphaOn || opacity < 1)}
            onChange={(e) => setBlend(e.target.value as BlendMode)}
          >
            <option value="normal">Normal</option>
            <option value="translucent">Translucent</option>
            <option value="additive">Additive</option>
          </select>
        </label>
        <label className="clouds-control" title="whole-cloud opacity — also the exposure control for additive blending">
          opacity
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(parseFloat(e.target.value))}
          />
        </label>
        <span className="clouds-sep" />
        <label
          className="clouds-check"
          title="eye-dome lighting — shades depth edges so unlit lidar reads as surfaces (translucent/additive blends aren't shaded)"
        >
          <input type="checkbox" checked={edl} onChange={(e) => setEdl(e.target.checked)} />
          EDL
        </label>
        <label className="clouds-control" title="EDL strength">
          strength
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.1}
            value={edlStrength}
            disabled={!edl}
            onChange={(e) => setEdlStrength(parseFloat(e.target.value))}
          />
        </label>
        <span className="clouds-sep" />
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
        <span className="clouds-sep" />
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
            <RunClouds quiet onOpen={(url, name) => void loadUrl(url, name)} />
          </div>
        )}
        {showRuns && (
          <div className="clouds-overlay clouds-runs-panel">
            <div className="clouds-runs-card" role="dialog" aria-label="rig runs">
              <header>
                <span>Rig runs</span>
                <button className="btn-link" onClick={() => setShowRuns(false)} aria-label="close">
                  ✕
                </button>
              </header>
              <RunClouds
                onOpen={(url, name) => {
                  setShowRuns(false);
                  void loadUrl(url, name);
                }}
              />
            </div>
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
        {showLegend && scale && (
          <div className="clouds-legend">
            <div className="clouds-legend-row">
              <span className="clouds-legend-name">{scale.label}</span>
              <input
                key={`min-${scale.label}-${scale.min}-${nonce}`}
                ref={minRef}
                className="field clouds-legend-num"
                type="number"
                step="any"
                defaultValue={fmt(scale.min, span)}
                title="scale minimum — edit to clamp the color range"
                onBlur={applyRange}
                onKeyDown={onRangeKey}
              />
              <canvas ref={legendRef} className="clouds-legend-bar" width={256} height={1} />
              <input
                key={`max-${scale.label}-${scale.max}-${nonce}`}
                ref={maxRef}
                className="field clouds-legend-num"
                type="number"
                step="any"
                defaultValue={fmt(scale.max, span)}
                title="scale maximum — edit to clamp the color range"
                onBlur={applyRange}
                onKeyDown={onRangeKey}
              />
              {!scale.auto && (
                <button
                  className="btn-link"
                  title="back to the automatic 2–98% percentile range"
                  onClick={() => {
                    viewerRef.current?.setColorRange(null);
                    refreshScale();
                  }}
                >
                  auto
                </button>
              )}
            </div>
            <label className="clouds-legend-row" title="gamma — below 1 lifts dark values (skewed intensity usually wants ~0.5)">
              γ
              <input
                type="range"
                min={-2}
                max={2}
                step={0.05}
                value={Math.log2(scale.gamma)}
                onChange={(e) => {
                  viewerRef.current?.setColorGamma(2 ** parseFloat(e.target.value));
                  refreshScale();
                }}
              />
              <span className="clouds-legend-gamma mono">{scale.gamma.toFixed(2)}</span>
            </label>
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
