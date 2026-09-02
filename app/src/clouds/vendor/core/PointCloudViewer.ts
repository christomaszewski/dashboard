/**
 * Framework-agnostic Three.js point cloud viewer. Owns a canvas inside the
 * given container; feed it PointCloudData via setPointCloud(). Z-up world to
 * match geospatial/lidar conventions.
 *
 * Rendering is two layers: the grid and basemap draw straight to the canvas,
 * then the points render into an offscreen target (linear color + depth) and
 * a full-screen pass composites them on top with eye-dome lighting. Keeping
 * the underlay out of that target means EDL never darkens map imagery
 * between sparse ground points, and points can't z-fight the grid.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PointCloudData } from '../loaders/types';
import { BasemapLayer, type BasemapId } from './BasemapLayer';
import { colormapData, type ColormapName } from './colormaps';

export type ColorSpec =
  | { mode: 'height' }
  | { mode: 'attribute'; name: string }
  | { mode: 'flat'; color?: string };

/**
 * Per-point opacity. Driving it from intensity is the classic way to bring
 * out surface texture in a lidar cloud that has no RGB: return strength
 * varies with material and incidence angle, so roads, roof edges and
 * vegetation separate even where the colormap is flat.
 */
export type AlphaSpec =
  | { mode: 'none' }
  | { mode: 'attribute'; name: string; floor?: number };

/**
 * How translucent points composite (only matters once an AlphaSpec is set
 * or the global opacity drops below 1):
 * - normal: alpha-blend against the background but still write depth, so
 *   near points keep occluding far ones — a "dim by intensity" look with no
 *   ordering artifacts.
 * - translucent: no depth write; points show through each other. Draw order
 *   is buffer order, so dense overlaps can look uneven from some angles.
 * - additive: contributions sum (order-independent). Dense areas glow —
 *   good for reading structure and density, less faithful for color.
 */
export type BlendMode = 'normal' | 'translucent' | 'additive';

/**
 * The active color scale, for a legend and manual range editing. Values are
 * absolute (attribute offset / cloud origin applied).
 */
export interface ColorScale {
  /** What is being mapped: 'Height (Z)' or an attribute name. */
  label: string;
  map: ColormapName;
  min: number;
  max: number;
  /** True while the range is the automatic 2–98% percentile one. */
  auto: boolean;
  gamma: number;
}

/** Opacity of the lowest-ranked points, so they don't vanish outright. */
const DEFAULT_ALPHA_FLOOR = 0.1;

/** Eye-dome lighting sample ring radius in CSS pixels. */
const EDL_RADIUS = 1.4;
const DEFAULT_EDL_STRENGTH = 1;

/** Camera presets: 3/4 overview, straight down, or a compass-side elevation. */
export type ViewPreset = 'fit' | 'top' | 'north' | 'south' | 'east' | 'west';

// Unit-ish camera offsets from the cloud center, Z-up / Y-north.
const VIEW_DIRECTIONS: Record<ViewPreset, [number, number, number]> = {
  fit: [0.55, -0.75, 0.45],
  // Tiny tilt keeps the view direction from degenerating against the Z-up vector.
  top: [0, -0.02, 1],
  north: [0, 1, 0],
  south: [0, -1, 0],
  east: [1, 0, 0],
  west: [-1, 0, 0],
};

const VERT = /* glsl */ `
  attribute float scalar;
  attribute float alphaScalar;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uRefDist;
  uniform bool uAttenuate;
  uniform bool uOrtho;
  uniform float uOrthoZoom;
  uniform int uMode; // 0 = attribute scalar, 1 = height, 2 = flat
  uniform int uAlphaMode; // 0 = opaque, 1 = attribute-driven
  uniform vec2 uAlphaRange;
  uniform float uAlphaFloor;
  uniform float uOpacity;
  varying float vScalar;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = uSize;
    // "Perspective size": scale with distance — or with zoom in ortho, where
    // view-space depth no longer changes as you dolly.
    if (uAttenuate)
      size *= uOrtho ? clamp(uOrthoZoom, 0.05, 20.0)
                     : clamp(uRefDist / max(-mv.z, 0.001), 0.05, 20.0);
    gl_PointSize = clamp(size * uPixelRatio, 1.0, 64.0);
    vScalar = (uMode == 1) ? position.z : scalar;
    float a = clamp((alphaScalar - uAlphaRange.x) / max(uAlphaRange.y - uAlphaRange.x, 1e-9), 0.0, 1.0);
    vAlpha = ((uAlphaMode == 1) ? mix(uAlphaFloor, 1.0, a) : 1.0) * uOpacity;
  }
`;

// Writes linear color; the composite pass encodes for the display.
const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uColormap;
  uniform vec2 uRange;
  uniform float uGamma;
  uniform vec3 uFlatColor;
  uniform int uMode;
  varying float vScalar;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    if (uMode == 2) {
      gl_FragColor = vec4(uFlatColor, vAlpha);
    } else {
      float t = clamp((vScalar - uRange.x) / max(uRange.y - uRange.x, 1e-9), 0.0, 1.0);
      t = pow(t, uGamma);
      gl_FragColor = vec4(texture2D(uColormap, vec2(t, 0.5)).rgb, vAlpha);
    }
  }
`;

const COMPOSITE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Composites the point layer over the canvas with eye-dome lighting
 * (Boucheny; parameters as in Potree): each pixel is darkened by how far it
 * sits behind its ring of neighbours, which outlines every depth
 * discontinuity and is what makes unlit lidar readable.
 */
const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tColor; // premultiplied linear rgb, coverage in alpha
  uniform sampler2D tDepth;
  uniform vec2 uTexel; // 1 / target size
  uniform float uRadius; // ring radius in target pixels
  uniform float uStrength; // 0 disables EDL
  uniform float uNear;
  uniform float uFar;
  uniform bool uOrtho;
  uniform float uOrthoScale;
  uniform bool uAdditive;
  varying vec2 vUv;

  // A depth metric whose differences are relative depth steps: log2 of the
  // view distance in perspective, linear depth scaled by zoom / distance in
  // ortho (so zooming in strengthens edges the way approaching does).
  // .y = 0 where nothing was drawn.
  vec2 edlDepth(vec2 uv) {
    float d = texture2D(tDepth, uv).r;
    if (d >= 1.0) return vec2(0.0);
    float lin = uOrtho ? uNear + d * (uFar - uNear)
                       : 2.0 * uNear * uFar / (uFar + uNear - (2.0 * d - 1.0) * (uFar - uNear));
    return vec2(uOrtho ? lin * uOrthoScale : log2(max(lin, 1e-6)), 1.0);
  }

  void main() {
    vec4 c = texture2D(tColor, vUv);
    if (c.a <= 0.0) discard;
    float shade = 1.0;
    vec2 z = edlDepth(vUv);
    if (uStrength > 0.0 && z.y > 0.0) {
      float sum = 0.0;
      for (int i = 0; i < 8; i++) {
        float ang = float(i) * 0.78539816;
        vec2 n = edlDepth(vUv + vec2(cos(ang), sin(ang)) * uRadius * uTexel);
        if (n.y > 0.0) sum += max(0.0, z.x - n.x); // empty neighbours don't vote
      }
      shade = exp(-sum * 37.5 * uStrength); // 300 / 8 neighbours
    }
    if (uAdditive) {
      gl_FragColor = vec4(c.rgb * shade, 1.0);
    } else {
      gl_FragColor = vec4(c.rgb / max(c.a, 1e-4) * shade, c.a);
    }
    #include <colorspace_fragment>
    if (!uAdditive) gl_FragColor.rgb *= gl_FragColor.a;
  }
`;

/**
 * 2–98% percentile range from a subsample, so a few outlier returns (noise
 * points, birds, multipath) don't crush the color ramp for the whole cloud.
 */
function robustRange(values: ArrayLike<number>, stride = 1, component = 0): [number, number] {
  const n = Math.floor(values.length / stride);
  if (n === 0) return [0, 1];
  const step = Math.max(1, Math.floor(n / 50_000));
  const samples: number[] = [];
  for (let i = 0; i < n; i += step) samples.push(values[i * stride + component]);
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(0.02 * (samples.length - 1))];
  const hi = samples[Math.ceil(0.98 * (samples.length - 1))];
  if (lo < hi) return [lo, hi];
  const [a, b] = [samples[0], samples[samples.length - 1]];
  return a < b ? [a, b] : [a - 0.5, a + 0.5];
}

export type ProjectionMode = 'perspective' | 'orthographic';

/** A per-point attribute uploaded once per cloud, shared by color and alpha. */
interface Scalar {
  buffer: THREE.BufferAttribute;
  range: [number, number];
  offset: number;
}

/** Manual tone settings, kept per color source so switching back restores them. */
interface Tone {
  /** Absolute units; null = automatic percentile range. */
  range: [number, number] | null;
  gamma: number;
}

export class PointCloudViewer {
  readonly renderer: THREE.WebGLRenderer;
  /** The point layer. */
  readonly scene: THREE.Scene;
  controls: OrbitControls;

  private persp: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  private projection: ProjectionMode = 'perspective';
  private orthoHalfHeight = 50;

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.projection === 'orthographic' ? this.ortho : this.persp;
  }

  /** Grid and basemap: drawn straight to the canvas, under the point layer. */
  private underlay = new THREE.Scene();
  private material: THREE.ShaderMaterial;
  private points: THREE.Points | null = null;
  private grid: THREE.GridHelper | null = null;
  private basemap: BasemapLayer | null = null;
  private data: PointCloudData | null = null;
  private textures = new Map<ColormapName, THREE.DataTexture>();
  private scalars = new Map<string, Scalar>();
  private heightRange: [number, number] = [0, 1];
  private colorSpec: ColorSpec = { mode: 'height' };
  private colorMap: ColormapName = 'viridis';
  private tones = new Map<string, Tone>();
  private blendMode: BlendMode = 'normal';
  private opacity = 1;
  private edlOn = true;
  private edlStrength = DEFAULT_EDL_STRENGTH;
  private target: THREE.WebGLRenderTarget;
  private composite: THREE.ShaderMaterial;
  private compositeScene = new THREE.Scene();
  private compositeCamera = new THREE.Camera();
  private resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // The point layer's target clears to transparent; the canvas takes its
    // color from the underlay's background.
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.underlay.background = new THREE.Color(0x0b0e14) /* VENDOR DELTA: dashboard --bg (upstream 0x14171c) */;

    this.persp = new THREE.PerspectiveCamera(60, 1, 0.1, 10_000);
    this.persp.up.set(0, 0, 1);
    this.persp.position.set(30, -30, 20);
    this.ortho = new THREE.OrthographicCamera(-50, 50, 50, -50, -1000, 10_000);
    this.ortho.up.set(0, 0, 1);

    this.controls = this.makeControls(this.persp);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSize: { value: 2 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uRefDist: { value: 50 },
        uAttenuate: { value: true },
        uOrtho: { value: false },
        uOrthoZoom: { value: 1 },
        uMode: { value: 1 },
        uColormap: { value: this.texture('viridis') },
        uRange: { value: new THREE.Vector2(0, 1) },
        uGamma: { value: 1 },
        uFlatColor: { value: new THREE.Color(0xdadfe8) },
        uAlphaMode: { value: 0 },
        uAlphaRange: { value: new THREE.Vector2(0, 1) },
        uAlphaFloor: { value: DEFAULT_ALPHA_FLOOR },
        uOpacity: { value: 1 },
      },
    });

    // Half-float keeps linear-light blending free of banding in the darks.
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
      stencilBuffer: false,
    });
    this.composite = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: EDL_RADIUS },
        uStrength: { value: DEFAULT_EDL_STRENGTH },
        uNear: { value: 0.1 },
        uFar: { value: 10_000 },
        uOrtho: { value: false },
        uOrthoScale: { value: 1 },
        uAdditive: { value: false },
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      // Source is premultiplied: lerp the canvas by coverage (or add, see applyBlendState).
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite);
    quad.frustumCulled = false;
    this.compositeScene.add(quad);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.material.uniforms.uOrthoZoom.value = this.ortho.zoom;
      this.renderFrame();
    });
  }

  setPointCloud(data: PointCloudData): void {
    this.clearCloud();
    this.data = data;
    this.heightRange = robustRange(data.positions, 3, 2);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    const { min, max } = data.localBounds;
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    const size = Math.max(max[0] - min[0], max[1] - min[1]) * 1.4 || 10;
    this.grid = new THREE.GridHelper(size, 20, 0x232b38, 0x1a212c) /* VENDOR DELTA: dashboard grid tones */;
    this.grid.rotation.x = Math.PI / 2; // GridHelper is XZ; rotate into XY for Z-up
    this.grid.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]);
    this.underlay.add(this.grid);

    this.setColor({ mode: 'height' }, 'viridis');
    this.setAlpha({ mode: 'none' });
    this.fitView();
  }

  setColor(spec: ColorSpec, map: ColormapName = 'viridis'): void {
    this.colorSpec = spec;
    this.colorMap = map;
    const u = this.material.uniforms;
    u.uColormap.value = this.texture(map);
    if (spec.mode === 'flat') {
      u.uMode.value = 2;
      if (spec.color) (u.uFlatColor.value as THREE.Color).set(spec.color);
      return;
    }
    if (spec.mode === 'height') {
      u.uMode.value = 1;
    } else {
      const s = this.scalar(spec.name);
      if (!s || !this.points) return;
      this.points.geometry.setAttribute('scalar', s.buffer);
      u.uMode.value = 0;
    }
    this.applyColorRange();
  }

  /**
   * Clamp the color scale to an absolute [min, max] (values beyond it
   * saturate), or pass null to return to the automatic percentile range.
   * Remembered per color source; the classification palette ignores it.
   */
  setColorRange(range: [number, number] | null): void {
    const src = this.colorSource();
    if (!src) return;
    this.tone(src.key).range = range && range[0] < range[1] ? [range[0], range[1]] : null;
    this.applyColorRange();
  }

  /**
   * Gamma on the normalized scalar before the colormap: below 1 lifts the
   * dark end, which is what heavily skewed intensity data usually needs.
   */
  setColorGamma(gamma: number): void {
    const src = this.colorSource();
    if (!src) return;
    this.tone(src.key).gamma = THREE.MathUtils.clamp(gamma, 0.05, 20);
    this.applyColorRange();
  }

  /** Current scale for a legend; null while coloring flat or with no cloud. */
  getColorScale(): ColorScale | null {
    const src = this.colorSource();
    if (!src) return null;
    const tone = this.tones.get(src.key);
    const [min, max] = tone?.range ?? [src.auto[0] + src.offset, src.auto[1] + src.offset];
    return { label: src.label, map: this.colorMap, min, max, auto: !tone?.range, gamma: tone?.gamma ?? 1 };
  }

  /**
   * Drive each point's opacity from an attribute: its 2–98% percentile range
   * maps to floor…1 (see DEFAULT_ALPHA_FLOOR). Independent of setColor, so
   * e.g. color by height while intensity supplies the texture.
   */
  setAlpha(spec: AlphaSpec): void {
    const u = this.material.uniforms;
    const s = spec.mode === 'attribute' ? this.scalar(spec.name) : null;
    u.uAlphaMode.value = 0;
    if (spec.mode === 'attribute' && s && this.points) {
      this.points.geometry.setAttribute('alphaScalar', s.buffer);
      u.uAlphaRange.value.set(...s.range);
      u.uAlphaFloor.value = THREE.MathUtils.clamp(spec.floor ?? DEFAULT_ALPHA_FLOOR, 0, 1);
      u.uAlphaMode.value = 1;
    }
    this.applyBlendState();
  }

  /** Whole-cloud opacity multiplier (0–1); doubles as exposure for additive blending. */
  setOpacity(opacity: number): void {
    this.opacity = THREE.MathUtils.clamp(opacity, 0, 1);
    this.material.uniforms.uOpacity.value = this.opacity;
    this.applyBlendState();
  }

  setBlending(mode: BlendMode): void {
    this.blendMode = mode;
    this.applyBlendState();
  }

  getBlending(): BlendMode {
    return this.blendMode;
  }

  /**
   * Eye-dome lighting. Needs per-point depth, so the translucent and additive
   * blend modes (which don't write it) render unshaded.
   */
  setEdl(on: boolean): void {
    this.edlOn = on;
    this.syncEdl();
  }

  /** EDL contrast; 1 matches Potree's default, 0 is off. */
  setEdlStrength(strength: number): void {
    this.edlStrength = Math.max(0, strength);
    this.syncEdl();
  }

  setPointSize(px: number): void {
    this.material.uniforms.uSize.value = px;
  }

  setAttenuation(on: boolean): void {
    this.material.uniforms.uAttenuate.value = on;
  }

  setGridVisible(on: boolean): void {
    if (this.grid) this.grid.visible = on;
  }

  fitView(): void {
    this.setView('fit');
  }

  /** Frame the cloud from a preset direction ('north' = seen from the north). */
  setView(preset: ViewPreset): void {
    this.frameFrom(new THREE.Vector3(...VIEW_DIRECTIONS[preset]));
  }

  /**
   * Whether the loaded cloud can carry a basemap (needs a UTM georeference).
   */
  canShowBasemap(): boolean {
    return !!this.data?.utm;
  }

  /**
   * Show map tiles under the cloud, or remove them with null.
   * @param onTileError called with the running count of tiles that failed to
   *   load (offline machine, zoom not covered by the provider there).
   */
  setBasemap(id: BasemapId | null, onTileError?: (failed: number) => void): void {
    if (this.basemap) {
      this.underlay.remove(this.basemap.group);
      this.basemap.dispose();
      this.basemap = null;
    }
    if (!id || !this.data?.utm) return;
    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.basemap = new BasemapLayer(this.data, id, anisotropy, onTileError);
    this.underlay.add(this.basemap.group);
  }

  /** Switch between perspective and orthographic, preserving the view. */
  setProjection(mode: ProjectionMode): void {
    if (mode === this.projection) return;
    const target = this.controls.target.clone();

    if (mode === 'orthographic') {
      const dist = this.persp.position.distanceTo(target) || 50;
      this.ortho.position.copy(this.persp.position);
      // Match the perspective frustum's extent at the target plane.
      this.orthoHalfHeight = Math.tan((this.persp.fov * Math.PI) / 360) * dist;
      this.ortho.zoom = 1;
      this.syncOrthoFrustum(dist);
    } else {
      // Fold the ortho zoom into camera distance so apparent scale holds.
      const dist = (this.ortho.position.distanceTo(target) || 50) / this.ortho.zoom;
      const dir = this.ortho.position.clone().sub(target).normalize();
      this.persp.position.copy(target).addScaledVector(dir, dist);
      this.persp.near = Math.max(dist / 1000, 0.01);
      this.persp.far = Math.max(dist * 100, this.persp.far);
      this.persp.updateProjectionMatrix();
      this.material.uniforms.uRefDist.value = dist;
    }

    this.projection = mode;
    this.material.uniforms.uOrtho.value = mode === 'orthographic';
    this.controls.dispose();
    this.controls = this.makeControls(this.camera);
    this.controls.target.copy(target);
    this.controls.update();
  }

  getProjection(): ProjectionMode {
    return this.projection;
  }

  private makeControls(camera: THREE.Camera): OrbitControls {
    const controls = new OrbitControls(camera, this.renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    return controls;
  }

  /** Underlay to the canvas, points to the target, composite with EDL on top. */
  private renderFrame(): void {
    const r = this.renderer;
    const cam = this.camera;
    r.setRenderTarget(null);
    r.render(this.underlay, cam); // clears the canvas to the background
    r.setRenderTarget(this.target);
    r.render(this.scene, cam); // clears to transparent
    r.setRenderTarget(null);

    const u = this.composite.uniforms;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uOrtho.value = this.projection === 'orthographic';
    const dist = cam.position.distanceTo(this.controls.target) || 1;
    u.uOrthoScale.value = (this.ortho.zoom / dist) * Math.LOG2E; // parity with log2 in perspective
    r.autoClear = false;
    r.render(this.compositeScene, this.compositeCamera);
    r.autoClear = true;
  }

  /** Where the color scalar comes from, with its automatic (raw-unit) range. */
  private colorSource(): { key: string; label: string; offset: number; auto: [number, number] } | null {
    const spec = this.colorSpec;
    if (!this.data || spec.mode === 'flat') return null;
    if (spec.mode === 'height')
      return { key: 'height', label: 'Height (Z)', offset: this.data.origin[2], auto: this.heightRange };
    const s = this.scalar(spec.name);
    return s && { key: `attr:${spec.name}`, label: spec.name, offset: s.offset, auto: s.range };
  }

  private tone(key: string): Tone {
    let t = this.tones.get(key);
    if (!t) this.tones.set(key, (t = { range: null, gamma: 1 }));
    return t;
  }

  /** Push the active source's range and gamma to the shader (raw units). */
  private applyColorRange(): void {
    const u = this.material.uniforms;
    const src = this.colorSource();
    if (!src) return;
    if (this.colorMap === 'classification') {
      // Map raw + offset onto palette texel centers: t = (class + 0.5) / 256.
      u.uRange.value.set(-src.offset - 0.5, 255.5 - src.offset);
      u.uGamma.value = 1;
      return;
    }
    const tone = this.tones.get(src.key);
    const [lo, hi] = tone?.range ? [tone.range[0] - src.offset, tone.range[1] - src.offset] : src.auto;
    u.uRange.value.set(lo, hi);
    u.uGamma.value = tone?.gamma ?? 1;
  }

  /**
   * Material state for the current alpha/opacity/blend combination. With
   * nothing translucent the cloud stays on the plain opaque path whatever
   * the blend mode, so the default costs nothing and can't show artifacts.
   */
  private applyBlendState(): void {
    const m = this.material;
    const blended = m.uniforms.uAlphaMode.value === 1 || this.opacity < 1;
    const mode = blended ? this.blendMode : 'normal';
    const additive = mode === 'additive';
    const blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    const depthWrite = mode === 'normal';
    // The composite adds an additive layer and lerps the others by coverage.
    this.composite.blendDst = additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
    this.composite.uniforms.uAdditive.value = additive;
    if (m.transparent === blended && m.blending === blending && m.depthWrite === depthWrite) return;
    m.transparent = blended;
    m.blending = blending;
    m.depthWrite = depthWrite;
    m.needsUpdate = true; // `transparent` is part of three's program cache key
  }

  private syncEdl(): void {
    this.composite.uniforms.uStrength.value = this.edlOn ? this.edlStrength : 0;
  }

  /** GPU buffer and robust range for a named attribute, built once per cloud. */
  private scalar(name: string): Scalar | null {
    let s = this.scalars.get(name);
    if (!s) {
      const attr = this.data?.attributes.find((a) => a.name === name);
      if (!attr) return null;
      s = { buffer: new THREE.BufferAttribute(attr.values, 1), range: robustRange(attr.values), offset: attr.offset };
      this.scalars.set(name, s);
    }
    return s;
  }

  /** Size the ortho frustum for the current half-height, aspect, and scene. */
  private syncOrthoFrustum(dist: number): void {
    const aspect = this.persp.aspect;
    const r = Math.max(this.points?.geometry.boundingSphere?.radius ?? 500, 1);
    this.ortho.top = this.orthoHalfHeight;
    this.ortho.bottom = -this.orthoHalfHeight;
    this.ortho.left = -this.orthoHalfHeight * aspect;
    this.ortho.right = this.orthoHalfHeight * aspect;
    this.ortho.near = dist - 8 * r; // may be negative — legal for ortho
    this.ortho.far = dist + 8 * r;
    this.ortho.updateProjectionMatrix();
  }

  private frameFrom(direction: THREE.Vector3): void {
    const sphere = this.points?.geometry.boundingSphere;
    if (!sphere) return;
    const r = Math.max(sphere.radius, 1);
    const dist = (r / Math.sin((this.persp.fov * Math.PI) / 360)) * 1.1;
    const dir = direction.clone().normalize();

    this.persp.position.copy(sphere.center).addScaledVector(dir, dist);
    this.persp.near = Math.max(dist / 1000, 0.01);
    this.persp.far = dist * 100;
    this.persp.updateProjectionMatrix();

    this.ortho.position.copy(sphere.center).addScaledVector(dir, dist);
    this.orthoHalfHeight = Math.tan((this.persp.fov * Math.PI) / 360) * dist;
    this.ortho.zoom = 1;
    this.syncOrthoFrustum(dist);

    this.controls.target.copy(sphere.center);
    this.controls.update();
    this.material.uniforms.uRefDist.value = dist;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.clearCloud();
    this.controls.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.material.dispose();
    this.composite.dispose();
    for (const child of this.compositeScene.children) (child as THREE.Mesh).geometry.dispose();
    this.target.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clearCloud(): void {
    this.setBasemap(null);
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.points = null;
    }
    if (this.grid) {
      this.underlay.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
    this.scalars.clear();
    this.tones.clear();
    this.data = null;
  }

  private texture(name: ColormapName): THREE.DataTexture {
    let tex = this.textures.get(name);
    if (!tex) {
      tex = new THREE.DataTexture(colormapData(name), 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = tex.minFilter = name === 'classification' ? THREE.NearestFilter : THREE.LinearFilter;
      tex.needsUpdate = true;
      this.textures.set(name, tex);
    }
    return tex;
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.syncOrthoFrustum(this.ortho.position.distanceTo(this.controls.target) || 50);
    const ratio = this.renderer.getPixelRatio();
    this.material.uniforms.uPixelRatio.value = ratio;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target.setSize(size.x, size.y);
    this.composite.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
    this.composite.uniforms.uRadius.value = EDL_RADIUS * ratio;
  }
}
