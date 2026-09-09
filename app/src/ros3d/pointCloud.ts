import { frameId, stampNs, type Vec3 } from "./math";

export const MAX_CLOUD_BYTES = 64 * 1024 * 1024;
export interface PointField { name: string; offset: number; datatype: number; count: number }
export interface ParsedCloud {
  frame: string;
  stamp: bigint;
  count: number;
  inputCount: number;
  invalidCount: number;
  sampledCount: number;
  origin: Vec3;
  positions: Float32Array;
  colors?: Uint8Array; // RGBA, normalized by the GPU
  scalars: Record<string, Float32Array>;
  fields: string[];
  bounds: { min: Vec3; max: Vec3 };
  bytes: number;
  warning?: string;
}
const SIZES = [0, 1, 1, 2, 2, 4, 4, 4, 8, 8, 8, 1];
const integer = (v: unknown, name: string, max = 0xffffffff): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) throw new Error(`invalid ${name}`);
  return v;
};

/** The point blob has its own endianness and strides, independent of the CDR envelope. */
export function parsePointCloud(message: unknown, maxPoints = 500_000): ParsedCloud {
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 1 || maxPoints > 2_000_000) throw new Error("invalid point budget");
  const m = message as Record<string, unknown>;
  if (!m || typeof m !== "object") throw new Error("invalid PointCloud2 message");
  const header = m.header as { frame_id?: unknown; stamp?: unknown } | undefined;
  const frame = frameId(header?.frame_id); const stamp = stampNs(header?.stamp);
  const width = integer(m.width, "width"); const height = integer(m.height, "height");
  const step = integer(m.point_step, "point_step", 65536); const row = integer(m.row_step, "row_step");
  const total = width * height;
  if (!Number.isSafeInteger(total) || total > 16_000_000) throw new Error("cloud exceeds input point budget");
  const expected = row * height;
  if (!Number.isSafeInteger(expected) || expected > MAX_CLOUD_BYTES || row < width * step || (total > 0 && step === 0))
    throw new Error("invalid cloud strides or byte budget exceeded");
  const data = m.data;
  if (!(data instanceof Uint8Array)) throw new Error("PointCloud2 data must decode to Uint8Array");
  if (data.byteLength !== expected) throw new Error(`cloud data length ${data.byteLength} != row_step × height (${expected})`);
  if (typeof m.is_bigendian !== "boolean") throw new Error("invalid is_bigendian");
  if (!Array.isArray(m.fields) || m.fields.length > 128) throw new Error("invalid PointField list");
  const fields: PointField[] = [];
  const names = new Set<string>();
  for (const value of m.fields) {
    const f = value as PointField;
    if (!f || typeof f.name !== "string" || !f.name || names.has(f.name)) throw new Error("empty or duplicate PointField name");
    names.add(f.name);
    const offset = integer(f.offset, `${f.name}.offset`); const count = integer(f.count, `${f.name}.count`, 65536);
    const datatype = integer(f.datatype, `${f.name}.datatype`, SIZES.length - 1);
    if (!SIZES[datatype] || count === 0 || offset + count * SIZES[datatype] > step) throw new Error(`unsupported or out-of-bounds field: ${f.name}`);
    fields.push({ name: f.name, offset, count, datatype });
  }
  const xyz = ["x", "y", "z"].map((name) => fields.find((f) => f.name === name && f.count === 1));
  if (xyz.some((f) => !f)) throw new Error("PointCloud2 requires scalar x, y, z fields");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength); const little = !m.is_bigendian;
  let unsafe = 0;
  const read = (offset: number, type: number): number => {
    switch (type) {
      case 1: return view.getInt8(offset);
      case 2: return view.getUint8(offset);
      case 3: return view.getInt16(offset, little);
      case 4: return view.getUint16(offset, little);
      case 5: return view.getInt32(offset, little);
      case 6: return view.getUint32(offset, little);
      case 7: return view.getFloat32(offset, little);
      case 8: return view.getFloat64(offset, little);
      case 9: case 10: {
        const v = type === 9 ? view.getBigInt64(offset, little) : view.getBigUint64(offset, little);
        if (v < BigInt(Number.MIN_SAFE_INTEGER) || v > BigInt(Number.MAX_SAFE_INTEGER)) { unsafe++; return NaN; }
        return Number(v);
      }
      case 11: return view.getUint8(offset) ? 1 : 0;
      default: throw new Error(`unsupported PointField datatype ${type}`);
    }
  };
  const colorField = fields.find((f) => ["rgba", "rgb"].includes(f.name) && f.count === 1 && [5, 6, 7].includes(f.datatype));
  const scalarFields = fields.filter((f) => f.count === 1 && !["x", "y", "z", "rgb", "rgba"].includes(f.name)).slice(0, 16);
  const capacity = Math.min(total, maxPoints, Math.floor(MAX_CLOUD_BYTES / (12 + (colorField ? 4 : 0) + scalarFields.length * 4)));
  const positions = new Float32Array(capacity * 3);
  const colors = colorField ? new Uint8Array(capacity * 4) : undefined;
  const scalars: Record<string, Float32Array> = Object.create(null);
  for (const f of scalarFields) scalars[f.name] = new Float32Array(capacity);
  let count = 0; let invalidCount = 0; let sampledCount = 0;
  let origin: Vec3 = [0, 0, 0];
  const min: Vec3 = [Infinity, Infinity, Infinity]; const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < total; i++) {
    // Uniform deterministic sampling covers the complete organized cloud rather than its first rows.
    if (total > capacity && Math.floor(i * capacity / total) === Math.floor((i - 1) * capacity / total)) { sampledCount++; continue; }
    const base = Math.floor(i / width) * row + (i % width) * step;
    const p = xyz.map((f) => read(base + f!.offset, f!.datatype)) as Vec3;
    if (!p.every(Number.isFinite)) { invalidCount++; continue; }
    if (count === 0) origin = [...p];
    const local = p.map((v, axis) => Math.fround(v - origin[axis])) as Vec3;
    if (!local.every(Number.isFinite)) { invalidCount++; continue; }
    for (let axis = 0; axis < 3; axis++) {
      positions[count * 3 + axis] = local[axis];
      min[axis] = Math.min(min[axis], local[axis]); max[axis] = Math.max(max[axis], local[axis]);
    }
    if (colors && colorField) {
      const bits = view.getUint32(base + colorField.offset, little);
      colors.set([(bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255, colorField.name === "rgba" ? bits >>> 24 : 255], count * 4);
    }
    for (const f of scalarFields) scalars[f.name][count] = read(base + f.offset, f.datatype);
    count++;
  }
  // Slices release unused backing memory (invalid points may dominate a depth cloud).
  const packed = count === capacity ? positions : positions.slice(0, count * 3);
  const packedColors = count === capacity ? colors : colors?.slice(0, count * 4);
  let bytes = packed.byteLength + (packedColors?.byteLength ?? 0);
  for (const name of Object.keys(scalars)) { if (count !== capacity) scalars[name] = scalars[name].slice(0, count); bytes += scalars[name].byteLength; }
  return { frame, stamp, count, inputCount: total, invalidCount, sampledCount, origin, positions: packed,
    colors: packedColors, scalars, fields: fields.map((f) => f.name), bounds: count ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] }, bytes,
    warning: unsafe ? `${unsafe} integers exceed safe numeric precision; those values were omitted` : undefined };
}
