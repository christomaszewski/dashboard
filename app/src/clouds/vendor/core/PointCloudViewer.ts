/**
 * Framework-agnostic Three.js point cloud viewer. Owns a canvas inside the
 * given container; feed it PointCloudData via setPointCloud(). Z-up world to
 * match geospatial/lidar conventions.
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
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uRefDist;
  uniform bool uAttenuate;
  uniform bool uOrtho;
  uniform float uOrthoZoom;
  uniform int uMode; // 0 = attribute scalar, 1 = height, 2 = flat
  varying float vScalar;
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
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uColormap;
  uniform vec2 uRange;
  uniform vec3 uFlatColor;
  uniform int uMode;
  varying float vScalar;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    if (uMode == 2) {
      gl_FragColor = vec4(uFlatColor, 1.0);
    } else {
      float t = clamp((vScalar - uRange.x) / max(uRange.y - uRange.x, 1e-9), 0.0, 1.0);
      gl_FragColor = vec4(texture2D(uColormap, vec2(t, 0.5)).rgb, 1.0);
    }
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

export class PointCloudViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  controls: OrbitControls;

  private persp: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  private projection: ProjectionMode = 'perspective';
  private orthoHalfHeight = 50;

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.projection === 'orthographic' ? this.ortho : this.persp;
  }

  private material: THREE.ShaderMaterial;
  private points: THREE.Points | null = null;
  private grid: THREE.GridHelper | null = null;
  private basemap: BasemapLayer | null = null;
  private data: PointCloudData | null = null;
  private textures = new Map<ColormapName, THREE.DataTexture>();
  private resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e14) /* VENDOR DELTA: dashboard --bg (upstream 0x14171c) */;

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
        uFlatColor: { value: new THREE.Color(0xdadfe8) },
      },
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.material.uniforms.uOrthoZoom.value = this.ortho.zoom;
      this.renderer.render(this.scene, this.camera);
    });
  }

  setPointCloud(data: PointCloudData): void {
    this.clearCloud();
    this.data = data;

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
    this.scene.add(this.grid);

    this.setColor({ mode: 'height' }, 'viridis');
    this.fitView();
  }

  setColor(spec: ColorSpec, map: ColormapName = 'viridis'): void {
    const u = this.material.uniforms;
    u.uColormap.value = this.texture(map);
    if (spec.mode === 'flat') {
      u.uMode.value = 2;
      if (spec.color) (u.uFlatColor.value as THREE.Color).set(spec.color);
      return;
    }
    if (spec.mode === 'height') {
      u.uMode.value = 1;
      const pos = this.data?.positions;
      if (pos) u.uRange.value.set(...robustRange(pos, 3, 2));
      return;
    }
    const attr = this.data?.attributes.find((a) => a.name === spec.name);
    if (!attr || !this.points) return;
    this.points.geometry.setAttribute('scalar', new THREE.BufferAttribute(attr.values, 1));
    u.uMode.value = 0;
    if (map === 'classification') {
      // Map raw + offset onto palette texel centers: t = (class + 0.5) / 256.
      u.uRange.value.set(-attr.offset - 0.5, 255.5 - attr.offset);
    } else {
      u.uRange.value.set(...robustRange(attr.values)); // shader sees raw values
    }
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
      this.scene.remove(this.basemap.group);
      this.basemap.dispose();
      this.basemap = null;
    }
    if (!id || !this.data?.utm) return;
    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.basemap = new BasemapLayer(this.data, id, anisotropy, onTileError);
    this.scene.add(this.basemap.group);
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
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
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
    this.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }
}
