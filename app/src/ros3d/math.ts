export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export interface RigidTransform { translation: Vec3; rotation: Quat }
export const identity = (): RigidTransform => ({ translation: [0, 0, 0], rotation: [0, 0, 0, 1] });
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
export function multiply(a: Quat, b: Quat): Quat {
  const [x, y, z, w] = a; const [X, Y, Z, W] = b;
  return [w * X + x * W + y * Z - z * Y, w * Y - x * Z + y * W + z * X,
    w * Z + x * Y - y * X + z * W, w * W - x * X - y * Y - z * Z];
}
/** a <- b composed with b <- c yields a <- c. */
export function compose(a: RigidTransform, b: RigidTransform): RigidTransform {
  return { translation: add(a.translation, rotate(a.rotation, b.translation)), rotation: multiply(a.rotation, b.rotation) };
}
export function inverse(t: RigidTransform): RigidTransform {
  const q: Quat = [-t.rotation[0], -t.rotation[1], -t.rotation[2], t.rotation[3]];
  return { rotation: q, translation: rotate(q, t.translation.map((n) => -n) as Vec3) };
}
export function interpolate(a: RigidTransform, b: RigidTransform, ratio: number): RigidTransform {
  let q = b.rotation;
  let dot = a.rotation.reduce((sum, n, i) => sum + n * q[i], 0);
  if (dot < 0) { q = q.map((n) => -n) as Quat; dot = -dot; }
  let left = 1 - ratio; let right = ratio;
  if (dot < 0.9995) {
    const theta = Math.acos(Math.min(1, dot));
    left = Math.sin((1 - ratio) * theta) / Math.sin(theta);
    right = Math.sin(ratio * theta) / Math.sin(theta);
  }
  const rotation = a.rotation.map((n, i) => n * left + q[i] * right) as Quat;
  const norm = Math.hypot(...rotation);
  return { rotation: rotation.map((n) => n / norm) as Quat,
    translation: a.translation.map((n, i) => n + (b.translation[i] - n) * ratio) as Vec3 };
}

export function stampNs(value: unknown): bigint {
  if (!value || typeof value !== "object") throw new Error("missing ROS timestamp");
  const { sec, nanosec } = value as { sec: unknown; nanosec: unknown };
  if (typeof sec !== "number" || !Number.isSafeInteger(sec) || typeof nanosec !== "number" ||
      !Number.isInteger(nanosec) || nanosec < 0 || nanosec >= 1e9) throw new Error("invalid ROS timestamp");
  return BigInt(sec) * 1_000_000_000n + BigInt(nanosec);
}

export function frameId(value: unknown): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || /\s/.test(value))
    throw new Error("frame ID must be non-empty, without whitespace or a leading slash");
  return value;
}
