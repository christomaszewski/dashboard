// Minimal BPF writer used by tests and the sample generator. Implemented
// directly from PDAL's BpfWriter/BpfHeader layout, independently of the
// parser in src/loaders/bpf.ts, so round-trip tests cross-check the two.
import { zlibSync } from 'fflate';

/**
 * @param {object} opts
 * @param {{label: string, offset?: number, values: Float32Array}[]} opts.dims
 *   Raw (offset-removed) float32 values per dimension; all same length.
 * @param {0|1|2} [opts.interleave] 0 dim-major, 1 point-major, 2 byte-major
 * @param {boolean} [opts.compress] zlib block compression
 * @param {number} [opts.blockBytes] compressed block size (to force multiple blocks)
 * @param {number} [opts.coordType] 0 Cartesian, 1 UTM, 2 TCR, 3 ENU
 * @param {number} [opts.coordId] UTM zone
 * @param {number[]} [opts.xform] 16 doubles, row-major
 * @returns {Uint8Array}
 */
export function writeBpfV3(opts) {
  const {
    dims,
    interleave = 0,
    compress = false,
    blockBytes = 1 << 20,
    coordType = 1,
    coordId = 18,
    xform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  } = opts;
  const n = dims[0].values.length;
  const numDim = dims.length;
  const headerLen = 176 + numDim * (24 + 32);

  const raw = interleaveData(dims, n, interleave);
  let payload;
  if (compress) {
    const blocks = [];
    for (let off = 0; off < raw.length; off += blockBytes) {
      const chunk = raw.subarray(off, Math.min(off + blockBytes, raw.length));
      const comp = zlibSync(chunk);
      const head = new DataView(new ArrayBuffer(8));
      head.setUint32(0, chunk.length, true);
      head.setUint32(4, comp.length, true);
      blocks.push(new Uint8Array(head.buffer), comp);
    }
    payload = concat(blocks);
  } else {
    payload = raw;
  }

  const out = new Uint8Array(headerLen + payload.length);
  const dv = new DataView(out.buffer);
  out.set([0x42, 0x50, 0x46, 0x21], 0); // "BPF!"
  out.set([0x30, 0x30, 0x30, 0x33], 4); // "0003"
  dv.setInt32(8, headerLen, true);
  dv.setUint8(12, numDim);
  dv.setUint8(13, interleave);
  dv.setUint8(14, compress ? 3 : 0); // 3 = zlib
  dv.setUint8(15, 0);
  dv.setInt32(16, n, true);
  dv.setInt32(20, coordType, true);
  dv.setInt32(24, coordId, true);
  dv.setFloat32(28, 1.0, true); // spacing
  for (let i = 0; i < 16; i++) dv.setFloat64(32 + i * 8, xform[i], true);
  dv.setFloat64(160, 0, true); // startTime
  dv.setFloat64(168, 0, true); // endTime

  writeDimBlocks(dv, out, 176, dims, 0);
  out.set(payload, headerLen);
  return out;
}

/** Legacy v1 (dim-major) / v2 (point-major) writer for parser tests. */
export function writeBpfV1(opts) {
  const { dims, version = 1, coordType = 1, coordId = 18 } = opts;
  const n = dims[0].values.length;
  const aux = dims.slice(3); // dims must start with X, Y, Z
  const headerLen = 100 + aux.length * (24 + 32);
  const raw = interleaveData(dims, n, version === 1 ? 0 : 1);

  const out = new Uint8Array(headerLen + raw.length);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, headerLen, true);
  dv.setInt32(4, version, true);
  dv.setInt32(8, n, true);
  dv.setInt32(12, aux.length, true);
  dv.setInt32(16, coordType, true);
  dv.setInt32(20, coordId, true);
  dv.setFloat32(24, 1.0, true);
  for (let d = 0; d < 3; d++) dv.setFloat64(28 + d * 8, dims[d].offset ?? 0, true);
  for (let d = 0; d < 3; d++) {
    const { min, max } = minMax(dims[d]);
    dv.setFloat64(52 + d * 16, min, true);
    dv.setFloat64(60 + d * 16, max, true);
  }
  writeDimBlocks(dv, out, 100, aux, 0);
  out.set(raw, headerLen);
  return out;
}

function writeDimBlocks(dv, out, at, dims, skip) {
  const nd = dims.length - skip;
  for (let d = 0; d < nd; d++) dv.setFloat64(at + d * 8, dims[skip + d].offset ?? 0, true);
  for (let d = 0; d < nd; d++) dv.setFloat64(at + nd * 8 + d * 8, minMax(dims[skip + d]).min, true);
  for (let d = 0; d < nd; d++) dv.setFloat64(at + nd * 16 + d * 8, minMax(dims[skip + d]).max, true);
  for (let d = 0; d < nd; d++) {
    const label = dims[skip + d].label;
    for (let c = 0; c < Math.min(label.length, 31); c++)
      out[at + nd * 24 + d * 32 + c] = label.charCodeAt(c);
  }
}

function minMax(dim) {
  const off = dim.offset ?? 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of dim.values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) (min = 0), (max = 0);
  return { min: min + off, max: max + off };
}

function interleaveData(dims, n, interleave) {
  const numDim = dims.length;
  const out = new Uint8Array(n * numDim * 4);
  if (interleave === 0) {
    const f32 = new Float32Array(out.buffer);
    for (let d = 0; d < numDim; d++) f32.set(dims[d].values, d * n);
  } else if (interleave === 1) {
    const f32 = new Float32Array(out.buffer);
    for (let i = 0; i < n; i++)
      for (let d = 0; d < numDim; d++) f32[i * numDim + d] = dims[d].values[i];
  } else {
    // byte-major: for each dim, byte 0 of every point, then byte 1, …
    for (let d = 0; d < numDim; d++) {
      const bytes = new Uint8Array(dims[d].values.buffer, dims[d].values.byteOffset, n * 4);
      for (let b = 0; b < 4; b++)
        for (let i = 0; i < n; i++) out[(d * 4 + b) * n + i] = bytes[i * 4 + b];
    }
  }
  return out;
}

function concat(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
