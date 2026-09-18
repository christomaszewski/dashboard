import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SceneModel, SceneScan } from "./sceneModel";
import type { CloudDisplay } from "./config";
import { add, rotate, type Vec3 } from "./math";

const VERTEX = `
attribute float scalar;
attribute vec4 rgba;
varying float value;
varying vec4 rgb;
uniform float pointSize;
uniform float pixelRatio;
uniform float colorMode;
uniform vec3 heightAxis;
uniform float heightOffset;
void main() {
  value = colorMode == 1.0 ? dot(heightAxis, position) + heightOffset : scalar;
  rgb = rgba;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = pointSize * pixelRatio;
}`;
const FRAGMENT = `
varying float value;
varying vec4 rgb;
uniform float colorMode;
uniform vec2 colorRange;
uniform vec3 flatColor;
uniform float opacity;
vec3 linearize(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
void main() {
  if (length(gl_PointCoord - vec2(0.5)) > 0.5) discard;
  vec3 c = flatColor;
  float a = opacity;
  if (colorMode == 3.0) { c = linearize(rgb.rgb); a *= rgb.a; }
  else if (colorMode > 0.0) {
    float t = clamp((value - colorRange.x) / max(colorRange.y - colorRange.x, 0.00001), 0.0, 1.0);
    c = linearize(t < 0.5 ? mix(vec3(0.22, 0.12, 0.45), vec3(0.08, 0.65, 0.65), t * 2.0)
      : mix(vec3(0.08, 0.65, 0.65), vec3(0.98, 0.9, 0.24), (t - 0.5) * 2.0));
  }
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
}`;
interface DrawnScan { points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>; style: string; scan: SceneScan }
export interface CameraPose { position: Vec3; target: Vec3; origin: Vec3; ortho: boolean; zoom: number }

/** Each viewport owns a renderer; source-space buffers and source data remain shared outside it. */
export class SceneRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private perspective = new THREE.PerspectiveCamera(60, 1, 0.02, 100000);
  private orthographic = new THREE.OrthographicCamera(-30, 30, 30, -30, 0.02, 100000);
  private controls: OrbitControls;
  private ortho = false;
  private scans = new Map<number, DrawnScan>();
  private origin: Vec3 = [0, 0, 0];
  private hasOrigin = false;
  private grid = new THREE.GridHelper(100, 20, 0x34435c, 0x202c3e);
  private axes = new THREE.AxesHelper(2);
  private frameGroup = new THREE.Group();
  private labels: { element: HTMLSpanElement; position: THREE.Vector3 }[] = [];
  private labelLayer: HTMLDivElement;
  private frameSignature = "";
  private observer: ResizeObserver;
  private visible = true;
  private disposed = false;
  private raf = 0;
  private lastDraw = 0;
  private lastFrames = 0;
  private lost = false;
  private following: string | undefined;
  private followedPosition: THREE.Vector3 | undefined;
  fps = 0;
  private frames = 0;
  private fpsAt = performance.now();
  constructor(private container: HTMLElement, private model: SceneModel, private report: (error: string) => void, pose?: CameraPose) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x0b111d);
    this.scene.background = new THREE.Color(0x0b111d);
    this.perspective.up.set(0, 0, 1); this.orthographic.up.set(0, 0, 1);
    this.perspective.position.set(25, -25, 20); this.orthographic.position.copy(this.perspective.position);
    this.controls = this.makeControls();
    this.grid.rotation.x = Math.PI / 2; this.scene.add(this.grid, this.axes, this.frameGroup);
    container.appendChild(this.renderer.domElement);
    this.labelLayer = document.createElement("div"); this.labelLayer.className = "ros3d-frame-labels"; container.appendChild(this.labelLayer);
    this.renderer.domElement.addEventListener("webglcontextlost", this.contextLost);
    this.renderer.domElement.addEventListener("webglcontextrestored", this.contextRestored);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(container);
    if (pose) this.restore(pose);
    this.resize(); this.animate();
  }
  private contextLost = (event: Event) => { event.preventDefault(); this.lost = true; this.report("Graphics context lost; waiting for recovery"); };
  private contextRestored = () => { this.lost = false; this.report(""); this.clearDrawn(); this.resize(); };
  private get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera { return this.ortho ? this.orthographic : this.perspective; }
  private makeControls(): OrbitControls {
    const controls = new OrbitControls(this.camera, this.renderer.domElement); controls.enableDamping = true;
    controls.addEventListener("start", () => { this.following = undefined; this.followedPosition = undefined; });
    return controls;
  }
  setVisible(visible: boolean): void { this.visible = visible; if (visible) this.resize(); else this.clearDrawn(); }
  setFollow(frame: string): void { this.following = frame || undefined; this.followedPosition = undefined; }
  setOrthographic(value: boolean): void {
    if (value === this.ortho) return;
    const position = this.camera.position.clone(); const target = this.controls.target.clone();
    this.ortho = value; this.camera.position.copy(position);
    const distance = position.distanceTo(target) || 30;
    if (value) this.orthographic.zoom = Math.max(0.01, 60 / distance);
    this.controls.dispose(); this.controls = this.makeControls(); this.controls.target.copy(target); this.resize();
  }
  top(): void { const target = this.controls.target; this.camera.position.copy(target).add(new THREE.Vector3(0, -0.001, Math.max(10, this.camera.position.distanceTo(target)))); this.controls.update(); }
  fit(): void {
    const bounds = new THREE.Box3();
    for (const { points } of this.scans.values()) {
      points.updateMatrixWorld(true);
      if (points.geometry.boundingBox) bounds.union(points.geometry.boundingBox.clone().applyMatrix4(points.matrixWorld));
    }
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3()); const radius = Math.max(1, bounds.getSize(new THREE.Vector3()).length() / 2);
    this.controls.target.copy(center); this.camera.position.copy(center).add(new THREE.Vector3(1, -1, 0.8).normalize().multiplyScalar(radius * 2.8));
    this.orthographic.zoom = 25 / radius; this.resize(); this.controls.update();
  }
  pose(): CameraPose { return { position: this.camera.position.toArray() as Vec3, target: this.controls.target.toArray() as Vec3,
    origin: [...this.origin], ortho: this.ortho, zoom: this.orthographic.zoom }; }
  private restore(pose: CameraPose): void {
    this.origin = [...pose.origin]; this.hasOrigin = true; this.setOrthographic(pose.ortho);
    this.camera.position.fromArray(pose.position); this.controls.target.fromArray(pose.target); this.orthographic.zoom = pose.zoom;
  }
  private resize(): void {
    const width = this.container.clientWidth; const height = this.container.clientHeight;
    if (!width || !height || this.lost) return;
    this.renderer.setSize(width, height); this.perspective.aspect = width / height; this.perspective.updateProjectionMatrix();
    this.orthographic.left = -30 * width / height; this.orthographic.right = 30 * width / height; this.orthographic.updateProjectionMatrix();
  }
  private create(scan: SceneScan): DrawnScan {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(scan.cloud.positions, 3));
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...scan.cloud.bounds.min), new THREE.Vector3(...scan.cloud.bounds.max));
    geometry.setAttribute("rgba", new THREE.BufferAttribute(scan.cloud.colors ?? new Uint8Array(scan.cloud.count * 4).fill(255), 4, true));
    geometry.setAttribute("scalar", new THREE.BufferAttribute(new Float32Array(scan.cloud.count), 1));
    const material = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: true,
      uniforms: { pointSize: { value: 2 }, pixelRatio: { value: Math.min(devicePixelRatio, 2) }, colorMode: { value: 1 },
        colorRange: { value: new THREE.Vector2(0, 1) }, flatColor: { value: new THREE.Color("#6ad5ed") }, opacity: { value: 1 },
        heightAxis: { value: new THREE.Vector3(0, 0, 1) }, heightOffset: { value: 0 } } });
    const points = new THREE.Points(geometry, material); points.frustumCulled = false;
    const draw = { points, scan, style: "" }; this.place(draw);
    this.scene.add(points);
    return draw;
  }
  private place({ points, scan }: DrawnScan): void {
    const absolute = add(scan.transform.translation, rotate(scan.transform.rotation, scan.cloud.origin));
    if (!this.hasOrigin) { this.origin = [...absolute]; this.hasOrigin = true; }
    points.position.set(absolute[0] - this.origin[0], absolute[1] - this.origin[1], absolute[2] - this.origin[2]);
    points.quaternion.fromArray(scan.transform.rotation);
  }
  private attribute(draw: DrawnScan, name: string, values: Float32Array | Uint8Array): void {
    const attribute = draw.points.geometry.getAttribute(name) as THREE.BufferAttribute;
    attribute.array = values; attribute.needsUpdate = true;
  }
  private reuse(draw: DrawnScan, scan: SceneScan): void {
    draw.scan = scan; draw.style = "";
    this.attribute(draw, "position", scan.cloud.positions);
    this.attribute(draw, "rgba", scan.cloud.colors ?? new Uint8Array(scan.cloud.count * 4).fill(255));
    draw.points.geometry.boundingBox!.set(new THREE.Vector3(...scan.cloud.bounds.min), new THREE.Vector3(...scan.cloud.bounds.max));
    this.place(draw);
  }
  private style(draw: DrawnScan, display: CloudDisplay): void {
    const key = JSON.stringify([display.color, display.point_size, display.opacity]); if (draw.style === key) return; draw.style = key;
    const { points, scan } = draw; const u = points.material.uniforms; const { color } = display;
    u.pointSize.value = display.point_size; u.opacity.value = display.opacity;
    points.material.depthWrite = display.opacity === 1;
    u.flatColor.value.set(color.value ?? "#6ad5ed");
    u.colorMode.value = { flat: 0, height: 1, field: 2, intensity: 2, rgb: 3 }[color.mode];
    if (color.mode === "height") {
      const axis: Vec3 = [rotate(scan.transform.rotation, [1, 0, 0])[2], rotate(scan.transform.rotation, [0, 1, 0])[2], rotate(scan.transform.rotation, [0, 0, 1])[2]];
      // Subtract the render origin's Z before uploading uniforms to retain precision at UTM/ECEF scale.
      const offset = points.position.z;
      u.heightAxis.value.fromArray(axis); u.heightOffset.value = offset;
      const bounds = scan.cloud.bounds; let low = offset; let high = offset;
      for (let i = 0; i < 3; i++) { low += axis[i] * (axis[i] >= 0 ? bounds.min[i] : bounds.max[i]); high += axis[i] * (axis[i] >= 0 ? bounds.max[i] : bounds.min[i]); }
      u.colorRange.value.set(low, high);
    } else if (color.mode === "intensity" || color.mode === "field") {
      const values = scan.cloud.scalars[color.field ?? "intensity"];
      if (values) {
        this.attribute(draw, "scalar", values);
        let min = Infinity; let max = -Infinity;
        for (const v of values) if (Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); }
        u.colorRange.value.set(Number.isFinite(min) ? min : 0, Number.isFinite(max) ? max : 1);
      } else u.colorMode.value = 0;
    } else if (color.mode === "rgb" && !scan.cloud.colors) u.colorMode.value = 0;
  }
  private sync(): void {
    const wanted = new Set([...this.model.layers.values()].flatMap((l) => l.scans.map((s) => s.id)));
    const reusable: DrawnScan[] = [];
    for (const [id, draw] of this.scans) if (!wanted.has(id)) { this.scans.delete(id); reusable.push(draw); }
    for (const layer of this.model.layers.values()) for (const scan of layer.scans) {
      let draw = this.scans.get(scan.id);
      if (!draw) {
        const index = reusable.findIndex((old) => old.scan.cloud.count === scan.cloud.count);
        if (index >= 0) { draw = reusable.splice(index, 1)[0]; this.reuse(draw, scan); }
        else draw = this.create(scan);
        this.scans.set(scan.id, draw);
      }
      this.style(draw, layer.display);
    }
    for (const draw of reusable) this.disposeScan(draw);
    this.grid.visible = this.model.config.show_grid;
    this.axes.position.set(-this.origin[0], -this.origin[1], -this.origin[2]);
    this.grid.position.z = -this.origin[2];
  }
  private updateFrames(): void {
    const source = this.model.source; const fixed = this.model.config.fixed_frame;
    const show = this.model.config.show_frames; const names = source?.tf.names() ?? [];
    const signature = JSON.stringify([show, names]);
    if (signature !== this.frameSignature) {
      this.frameSignature = signature; this.clearFrames();
      if (show) for (const name of names.slice(0, 128)) {
        const axes = new THREE.AxesHelper(1); axes.name = name; this.frameGroup.add(axes);
        const element = document.createElement("span"); element.textContent = name; this.labelLayer.appendChild(element);
        this.labels.push({ element, position: new THREE.Vector3() });
      }
    }
    this.frameGroup.children.forEach((axes, i) => {
      try {
        const pose = source!.config.time_source === "ros_clock" && source!.time.stamp !== undefined
          ? source!.tf.lookup(fixed, axes.name, source!.time.stamp) : source!.tf.latest(fixed, axes.name).transform;
        axes.position.set(pose.translation[0] - this.origin[0], pose.translation[1] - this.origin[1], pose.translation[2] - this.origin[2]);
        axes.quaternion.fromArray(pose.rotation); axes.visible = true;
        this.labels[i].position.copy(axes.position);
      } catch { axes.visible = false; }
    });
    if (this.following && source && fixed) {
      try {
        const pose = source.tf.latest(fixed, this.following).transform;
        const position = new THREE.Vector3(pose.translation[0] - this.origin[0], pose.translation[1] - this.origin[1], pose.translation[2] - this.origin[2]);
        const delta = position.clone().sub(this.followedPosition ?? this.controls.target);
        this.camera.position.add(delta); this.controls.target.add(delta); this.followedPosition = position;
      } catch { /* Diagnostics in the view report unavailable frame paths. */ }
    }
  }
  private animate = (now = performance.now()): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    if (document.hidden) { if (this.scans.size) this.clearDrawn(); return; }
    if (!this.visible || !this.container.clientWidth || !this.container.clientHeight || this.lost || now - this.lastDraw < 1000 / 30) return;
    this.lastDraw = now - ((now - this.lastDraw) % (1000 / 30));
    this.model.tick(now); this.sync();
    if (now - this.lastFrames > 100) { this.lastFrames = now; this.updateFrames(); }
    this.controls.update(); this.renderer.render(this.scene, this.camera);
    this.labels.forEach((label, i) => {
      const p = label.position.clone().project(this.camera);
      label.element.hidden = !this.frameGroup.children[i]?.visible || p.z < -1 || p.z > 1;
      label.element.style.transform = `translate(${(p.x + 1) / 2 * this.container.clientWidth}px, ${(1 - p.y) / 2 * this.container.clientHeight}px)`;
    });
    this.frames++; if (now - this.fpsAt > 1000) { this.fps = this.frames * 1000 / (now - this.fpsAt); this.frames = 0; this.fpsAt = now; }
  };
  private disposeScan(draw: DrawnScan): void { this.scene.remove(draw.points); draw.points.geometry.dispose(); draw.points.material.dispose(); }
  private clearDrawn(): void { for (const draw of this.scans.values()) this.disposeScan(draw); this.scans.clear(); }
  private clearFrames(): void {
    for (const axes of [...this.frameGroup.children]) { (axes as THREE.AxesHelper).dispose(); this.frameGroup.remove(axes); }
    this.labelLayer.replaceChildren(); this.labels = [];
  }
  dispose(): void {
    this.disposed = true; cancelAnimationFrame(this.raf); this.observer.disconnect(); this.controls.dispose(); this.clearDrawn(); this.clearFrames();
    this.grid.dispose(); this.axes.dispose();
    this.renderer.domElement.removeEventListener("webglcontextlost", this.contextLost);
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.contextRestored);
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove(); this.labelLayer.remove();
  }
}
