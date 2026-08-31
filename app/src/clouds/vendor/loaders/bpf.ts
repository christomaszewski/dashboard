/**
 * BPF ("Binary Point Format") parser — v3 primarily, with best-effort v1/v2.
 *
 * Layout matches PDAL's reader (io/BpfReader.cpp), the de-facto reference.
 * All values little-endian. Point values are float32 residuals; each
 * dimension carries a float64 offset so large UTM coordinates keep precision.
 *
 * v3 fixed header (176 bytes):
 *   0   "BPF!"            4 bytes magic
 *   4   "0003"            4 bytes ASCII version
 *   8   i32  len          absolute file offset where point data starts
 *   12  u8   numDim
 *   13  u8   interleave   0 = dim-major, 1 = point-major, 2 = byte-major
 *   14  u8   compression  0 = none, 3 = zlib (1/2 = QuickLZ/FastLZ, unsupported)
 *   15  u8   (unused)
 *   16  i32  numPts
 *   20  i32  coordType    0 = Cartesian, 1 = UTM, 2 = TCR/ECEF, 3 = ENU
 *   24  i32  coordId      UTM zone (negative = southern hemisphere)
 *   28  f32  spacing
 *   32  f64 ×16           4×4 transform, row-major, translation in col 3
 *   160 f64  startTime
 *   168 f64  endTime
 * then dimension descriptors in blocks: numDim × f64 offsets, × f64 mins,
 * × f64 maxs, × 32-byte NUL-padded labels. Point data begins at `len`.
 *
 * zlib-compressed data is a sequence of blocks:
 *   u32 rawSize, u32 compressedSize, <compressedSize bytes of zlib stream>
 * concatenating to numPts × numDim × 4 bytes.
 */
import { unzlibSync } from 'fflate';
import type { PointAttribute, PointCloudData } from './types';

export const enum BpfInterleave {
  DimMajor = 0,
  PointMajor = 1,
  ByteMajor = 2,
}

interface BpfDim {
  label: string;
  offset: number;
  min: number;
  max: number;
}

class BpfError extends Error {
  constructor(msg: string) {
    super(`BPF: ${msg}`);
    this.name = 'BpfError';
  }
}

function readAscii(bytes: Uint8Array, start: number, len: number): string {
  let end = start;
  const stop = start + len;
  while (end < stop && bytes[end] !== 0) end++;
  return String.fromCharCode(...bytes.subarray(start, end)).trim();
}

export function parseBpf(buffer: ArrayBuffer): PointCloudData {
  if (buffer.byteLength < 16) throw new BpfError('file too small to be a BPF file');
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  return magic === 'BPF!' ? parseV3(buffer) : parseV1V2(buffer);
}

function parseV3(buffer: ArrayBuffer): PointCloudData {
  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const version = parseInt(readAscii(bytes, 4, 4), 10);
  if (version !== 3) throw new BpfError(`unsupported BPF version ${version}`);

  const len = dv.getInt32(8, true);
  const numDim = dv.getUint8(12);
  const interleave = dv.getUint8(13);
  const compression = dv.getUint8(14);
  const numPts = dv.getInt32(16, true);
  const coordType = dv.getInt32(20, true);
  const coordId = dv.getInt32(24, true);
  const spacing = dv.getFloat32(28, true);
  const xform = new Float64Array(16);
  for (let i = 0; i < 16; i++) xform[i] = dv.getFloat64(32 + i * 8, true);
  const startTime = dv.getFloat64(160, true);
  const endTime = dv.getFloat64(168, true);

  if (interleave > 2) throw new BpfError(`unknown interleave type ${interleave}`);
  if (numPts < 0) throw new BpfError(`bad point count ${numPts}`);
  if (numDim < 3) throw new BpfError(`only ${numDim} dimensions; expected at least X, Y, Z`);

  // Dimension descriptor blocks follow the fixed header.
  const dimBytes = numDim * (8 * 3 + 32);
  if (176 + dimBytes > buffer.byteLength || 176 + dimBytes > len)
    throw new BpfError('truncated dimension table');
  const dims: BpfDim[] = [];
  for (let d = 0; d < numDim; d++) {
    dims.push({
      label: readAscii(bytes, 176 + numDim * 24 + d * 32, 32),
      offset: dv.getFloat64(176 + d * 8, true),
      min: dv.getFloat64(176 + numDim * 8 + d * 8, true),
      max: dv.getFloat64(176 + numDim * 16 + d * 8, true),
    });
  }

  const data = pointData(buffer, len, numPts, numDim, compression);
  const crs = crsName(coordType, coordId);
  return assemble(data, dims, numPts, interleave, xform, crs, {
    format: 'bpf',
    version,
    coordType,
    coordId,
    spacing,
    startTime,
    endTime,
    compression,
  });
}

/**
 * Legacy v1/v2: no magic. Header is i32 len, i32 version, i32 numPts,
 * i32 numAuxDim, i32 coordType, i32 coordId, f32 spacing, then X/Y/Z
 * offsets (3 × f64) and min/max pairs (3 × 2 × f64), then descriptor
 * blocks for the auxiliary dimensions. v1 data is dim-major, v2 point-major.
 * Best-effort: implemented per PDAL but untested against real legacy files.
 */
function parseV1V2(buffer: ArrayBuffer): PointCloudData {
  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const len = dv.getInt32(0, true);
  const version = dv.getInt32(4, true);
  if (version !== 1 && version !== 2)
    throw new BpfError('not a BPF file (no "BPF!" magic and not a v1/v2 header)');

  const numPts = dv.getInt32(8, true);
  const numAux = dv.getInt32(12, true);
  const coordType = dv.getInt32(16, true);
  const coordId = dv.getInt32(20, true);
  const spacing = dv.getFloat32(24, true);

  const numDim = numAux + 3;
  const dims: BpfDim[] = [
    { label: 'X', offset: dv.getFloat64(28, true), min: dv.getFloat64(52, true), max: dv.getFloat64(60, true) },
    { label: 'Y', offset: dv.getFloat64(36, true), min: dv.getFloat64(68, true), max: dv.getFloat64(76, true) },
    { label: 'Z', offset: dv.getFloat64(44, true), min: dv.getFloat64(84, true), max: dv.getFloat64(92, true) },
  ];
  let o = 100;
  if (o + numAux * (24 + 32) > buffer.byteLength) throw new BpfError('truncated dimension table');
  for (let d = 0; d < numAux; d++) dims.push({ label: '', offset: dv.getFloat64(o + d * 8, true), min: 0, max: 0 });
  o += numAux * 8;
  for (let d = 0; d < numAux; d++) dims[3 + d].min = dv.getFloat64(o + d * 8, true);
  o += numAux * 8;
  for (let d = 0; d < numAux; d++) dims[3 + d].max = dv.getFloat64(o + d * 8, true);
  o += numAux * 8;
  for (let d = 0; d < numAux; d++) dims[3 + d].label = readAscii(bytes, o + d * 32, 32) || `dim${3 + d}`;

  const interleave = version === 1 ? BpfInterleave.DimMajor : BpfInterleave.PointMajor;
  const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const data = pointData(buffer, len, numPts, numDim, 0);
  return assemble(data, dims, numPts, interleave, identity, crsName(coordType, coordId), {
    format: 'bpf',
    version,
    coordType,
    coordId,
    spacing,
  });
}

/** Extract (and inflate if needed) the raw float32 point data segment. */
function pointData(
  buffer: ArrayBuffer,
  start: number,
  numPts: number,
  numDim: number,
  compression: number,
): Uint8Array {
  const expected = numPts * numDim * 4;
  if (start < 0 || start > buffer.byteLength) throw new BpfError(`bad header length ${start}`);

  if (compression !== 0) {
    // PDAL treats any non-zero value as its zlib block scheme.
    const dv = new DataView(buffer);
    const out = new Uint8Array(expected);
    let pos = start;
    let idx = 0;
    while (idx < expected) {
      if (pos + 8 > buffer.byteLength) throw new BpfError('truncated compressed data');
      const rawSize = dv.getUint32(pos, true);
      const compSize = dv.getUint32(pos + 4, true);
      pos += 8;
      if (pos + compSize > buffer.byteLength) throw new BpfError('truncated compressed block');
      let inflated: Uint8Array;
      try {
        inflated = unzlibSync(new Uint8Array(buffer, pos, compSize));
      } catch (e) {
        throw new BpfError(
          `zlib inflate failed (compression byte ${compression}; QuickLZ/FastLZ are unsupported): ${e}`,
        );
      }
      if (inflated.length !== rawSize)
        throw new BpfError(`compressed block decoded to ${inflated.length} bytes, expected ${rawSize}`);
      out.set(inflated.subarray(0, Math.min(inflated.length, expected - idx)), idx);
      idx += inflated.length;
      pos += compSize;
    }
    return out;
  }

  const avail = buffer.byteLength - start;
  if (avail < expected)
    throw new BpfError(`point data truncated: need ${expected} bytes, file has ${avail}`);
  // Realign if the header length isn't float-aligned (rare, but legal).
  if (start % 4 !== 0) return new Uint8Array(buffer.slice(start, start + expected));
  return new Uint8Array(buffer, start, expected);
}

/** Per-dimension raw float32 values for one dim, decoded from any interleave. */
function dimValues(data: Uint8Array, d: number, n: number, numDim: number, interleave: number): Float32Array {
  switch (interleave) {
    case BpfInterleave.DimMajor: {
      const out = new Float32Array(n);
      out.set(new Float32Array(data.buffer, data.byteOffset + d * n * 4, n));
      return out;
    }
    case BpfInterleave.PointMajor: {
      const all = new Float32Array(data.buffer, data.byteOffset, n * numDim);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = all[i * numDim + d];
      return out;
    }
    case BpfInterleave.ByteMajor: {
      const packed = new Uint8Array(n * 4);
      for (let b = 0; b < 4; b++) {
        const src = data.subarray((d * 4 + b) * n, (d * 4 + b) * n + n);
        for (let i = 0; i < n; i++) packed[i * 4 + b] = src[i];
      }
      return new Float32Array(packed.buffer);
    }
    default:
      throw new BpfError(`unknown interleave type ${interleave}`);
  }
}

function isIdentity(m: Float64Array): boolean {
  for (let i = 0; i < 16; i++) {
    const want = i % 5 === 0 ? 1 : 0;
    if (m[i] !== want) return false;
  }
  return true;
}

function assemble(
  data: Uint8Array,
  dims: BpfDim[],
  n: number,
  interleave: number,
  xform: Float64Array,
  crs: string | undefined,
  source: PointCloudData['source'],
): PointCloudData {
  const xi = dims.findIndex((d) => d.label === 'X');
  const yi = dims.findIndex((d) => d.label === 'Y');
  const zi = dims.findIndex((d) => d.label === 'Z');
  if (xi < 0 || yi < 0 || zi < 0)
    throw new BpfError(`missing X, Y or Z dimension (found: ${dims.map((d) => d.label).join(', ')})`);

  const rawX = dimValues(data, xi, n, dims.length, interleave);
  const rawY = dimValues(data, yi, n, dims.length, interleave);
  const rawZ = dimValues(data, zi, n, dims.length, interleave);

  // Origin: transform of the declared bounds midpoint (falls back to the
  // dimension offsets when a writer left min/max unset).
  const applyXform = !isIdentity(xform);
  const mid = (d: BpfDim) =>
    Number.isFinite(d.min) && Number.isFinite(d.max) && d.min <= d.max ? (d.min + d.max) / 2 : d.offset;
  let origin: [number, number, number] = [mid(dims[xi]), mid(dims[yi]), mid(dims[zi])];
  if (applyXform) origin = transform(xform, origin[0], origin[1], origin[2]);

  const positions = new Float32Array(n * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const [offX, offY, offZ] = [dims[xi].offset, dims[yi].offset, dims[zi].offset];
  for (let i = 0; i < n; i++) {
    let x = rawX[i] + offX;
    let y = rawY[i] + offY;
    let z = rawZ[i] + offZ;
    if (applyXform) [x, y, z] = transform(xform, x, y, z);
    const lx = x - origin[0];
    const ly = y - origin[1];
    const lz = z - origin[2];
    positions[i * 3] = lx;
    positions[i * 3 + 1] = ly;
    positions[i * 3 + 2] = lz;
    if (lx < min[0]) min[0] = lx;
    if (ly < min[1]) min[1] = ly;
    if (lz < min[2]) min[2] = lz;
    if (lx > max[0]) max[0] = lx;
    if (ly > max[1]) max[1] = ly;
    if (lz > max[2]) max[2] = lz;
  }
  if (n === 0) min.fill(0), max.fill(0);

  const attributes: PointAttribute[] = [];
  for (let d = 0; d < dims.length; d++) {
    if (d === xi || d === yi || d === zi) continue;
    const values = dimValues(data, d, n, dims.length, interleave);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo > hi) (lo = 0), (hi = 0);
    attributes.push({
      name: dims[d].label || `dim${d}`,
      values,
      offset: dims[d].offset,
      min: lo + dims[d].offset,
      max: hi + dims[d].offset,
    });
  }

  const coordType = source.coordType as number | undefined;
  const coordId = source.coordId as number | undefined;
  const utm =
    coordType === 1 && coordId !== undefined && coordId !== 0
      ? { zone: Math.abs(coordId), south: coordId < 0 }
      : undefined;

  return {
    count: n,
    positions,
    origin,
    localBounds: { min, max },
    attributes,
    crs,
    utm,
    source: { ...source, dimensions: dims.map((d) => d.label) },
  };
}

/** Row-major 4×4 with projective bottom row, translation in column 3. */
function transform(m: Float64Array, x: number, y: number, z: number): [number, number, number] {
  const w = x * m[12] + y * m[13] + z * m[14] + m[15];
  return [
    (x * m[0] + y * m[1] + z * m[2] + m[3]) / w,
    (x * m[4] + y * m[5] + z * m[6] + m[7]) / w,
    (x * m[8] + y * m[9] + z * m[10] + m[11]) / w,
  ];
}

function crsName(coordType: number, coordId: number): string | undefined {
  switch (coordType) {
    case 0:
      return 'Cartesian (WGS84)';
    case 1:
      return `UTM zone ${Math.abs(coordId)}${coordId < 0 ? 'S' : 'N'} (WGS84)`;
    case 2:
      return 'ECEF (EPSG:4978)';
    case 3:
      return 'ENU';
    default:
      return undefined;
  }
}
