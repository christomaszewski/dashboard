// Minimal LAS writer used by tests. Implemented straight from the ASPRS LAS 1.4 R15 layout,
// independently of the parser in src/loaders/las.ts, so round-trip tests cross-check the two.

const FORMAT_SIZE = { 0: 20, 1: 28, 2: 26, 3: 34, 4: 57, 5: 63, 6: 30, 7: 36, 8: 38, 9: 59, 10: 67 };

/**
 * @param {object} opts
 * @param {[number, number]} [opts.version]  [1, 2] (default) | [1, 3] | [1, 4]
 * @param {number} [opts.format]             point data record format 0–10 (default 0)
 * @param {{x: number, y: number, z: number, intensity?: number, classification?: number,
 *          returnNumber?: number, gpsTime?: number, red?: number, green?: number, blue?: number,
 *          nir?: number}[]} opts.points
 * @param {[number, number, number]} [opts.scale]
 * @param {[number, number, number]} [opts.offset]
 * @param {number} [opts.extraBytes]         bytes appended to EVERY record (record length > format size)
 * @param {number} [opts.epsg]               write a GeoKeyDirectory VLR carrying ProjectedCSTypeGeoKey
 * @param {string} [opts.wkt]                write an OGC WKT VLR
 * @param {boolean} [opts.laz]               flag the file LAZ (format bit 7 + the laszip VLR)
 * @param {boolean} [opts.legacyCountZero]   1.4: leave the legacy u32 count at 0 (64-bit field only)
 * @param {boolean} [opts.noBounds]          leave the header bounds unset (min > max)
 * @param {number} [opts.declaredCount]      lie about the point count (a truncated file)
 * @returns {Uint8Array}
 */
export function writeLas(opts) {
  const {
    version = [1, 2],
    format = 0,
    points,
    scale = [0.001, 0.001, 0.001],
    offset = [0, 0, 0],
    extraBytes = 0,
    epsg,
    wkt,
    laz = false,
    legacyCountZero = false,
    noBounds = false,
    declaredCount,
  } = opts;
  const [major, minor] = version;
  const headerSize = minor >= 4 ? 375 : minor === 3 ? 235 : 227;
  const recordLength = FORMAT_SIZE[format] + extraBytes;
  const n = points.length;

  // VLRs
  const vlrs = [];
  const vlr = (userId, recordId, body) => {
    const h = new Uint8Array(54);
    const v = new DataView(h.buffer);
    for (let i = 0; i < userId.length; i++) h[2 + i] = userId.charCodeAt(i);
    v.setUint16(18, recordId, true);
    v.setUint16(20, body.length, true);
    vlrs.push(h, body);
  };
  if (epsg !== undefined) {
    const b = new Uint8Array(16);
    const v = new DataView(b.buffer);
    [1, 1, 0, 1].forEach((x, i) => v.setUint16(i * 2, x, true)); // key directory header
    [3072, 0, 1, epsg].forEach((x, i) => v.setUint16(8 + i * 2, x, true)); // ProjectedCSTypeGeoKey
    vlr('LASF_Projection', 34735, b);
  }
  if (wkt !== undefined) vlr('LASF_Projection', 2112, new TextEncoder().encode(wkt + '\0'));
  if (laz) vlr('laszip encoded', 22204, new Uint8Array(34));
  const vlrBytes = vlrs.reduce((s, a) => s + a.length, 0);
  const offsetToPoints = headerSize + vlrBytes;

  const out = new Uint8Array(offsetToPoints + n * recordLength);
  const v = new DataView(out.buffer);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  str(0, 'LASF');
  out[24] = major;
  out[25] = minor;
  str(26, 'lasWrite.mjs');
  str(58, 'cloud-viewer tests');
  v.setUint16(94, headerSize, true);
  v.setUint32(96, offsetToPoints, true);
  v.setUint32(100, vlrs.length / 2, true);
  out[104] = format | (laz ? 0x80 : 0);
  v.setUint16(105, recordLength, true);
  const count = declaredCount ?? n;
  v.setUint32(107, minor >= 4 && legacyCountZero ? 0 : count, true);
  for (let i = 0; i < 3; i++) {
    v.setFloat64(131 + i * 8, scale[i], true);
    v.setFloat64(155 + i * 8, offset[i], true);
  }
  const axes = ['x', 'y', 'z'];
  for (let i = 0; i < 3; i++) {
    const vals = points.map((p) => p[axes[i]]);
    const max = noBounds ? 0 : Math.max(...vals);
    const min = noBounds ? 1 : Math.min(...vals);
    v.setFloat64(179 + i * 16, max, true);
    v.setFloat64(187 + i * 16, min, true);
  }
  if (minor >= 4) {
    v.setUint32(247, count >>> 0, true);
    v.setUint32(251, Math.floor(count / 2 ** 32), true);
  }
  let at = headerSize;
  for (const a of vlrs) { out.set(a, at); at += a.length; }

  const modern = format >= 6;
  const gps = modern ? 22 : [1, 3, 4, 5].includes(format) ? 20 : -1;
  const rgb = format === 2 ? 20 : format === 3 || format === 5 ? 28 : format >= 7 ? 30 : -1;
  const nir = format === 8 || format === 10 ? 36 : -1;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const at = offsetToPoints + i * recordLength;
    v.setInt32(at, Math.round((p.x - offset[0]) / scale[0]), true);
    v.setInt32(at + 4, Math.round((p.y - offset[1]) / scale[1]), true);
    v.setInt32(at + 8, Math.round((p.z - offset[2]) / scale[2]), true);
    v.setUint16(at + 12, p.intensity ?? 0, true);
    const ret = p.returnNumber ?? 1;
    out[at + 14] = modern ? (ret & 0x0f) | (1 << 4) : (ret & 0x07) | (1 << 3); // + number of returns = 1
    if (modern) out[at + 16] = p.classification ?? 0;
    else out[at + 15] = (p.classification ?? 0) & 0x1f;
    if (gps >= 0) v.setFloat64(at + gps, p.gpsTime ?? 0, true);
    if (rgb >= 0) {
      v.setUint16(at + rgb, p.red ?? 0, true);
      v.setUint16(at + rgb + 2, p.green ?? 0, true);
      v.setUint16(at + rgb + 4, p.blue ?? 0, true);
    }
    if (nir >= 0) v.setUint16(at + nir, p.nir ?? 0, true);
    for (let e = 0; e < extraBytes; e++) out[at + FORMAT_SIZE[format] + e] = 0xee; // never read
  }
  return out;
}
