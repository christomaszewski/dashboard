/**
 * LAS (ASPRS LASer file format) parser — versions 1.0–1.4, point data record
 * formats 0–10, uncompressed. LAZ (the compressed variant) is detected and
 * refused with a pointer to the fix; decoding it needs a LASzip port.
 *
 * Layout per the ASPRS specification (LAS 1.4 R15). All values little-endian.
 * Public header block (offsets in bytes):
 *   0    "LASF"           signature
 *   24   u8, u8           version major, minor
 *   26   char[32]         system identifier
 *   58   char[32]         generating software
 *   94   u16              header size (227: 1.0–1.2, 235: 1.3, 375: 1.4)
 *   96   u32              offset to point data
 *   100  u32              number of VLRs
 *   104  u8               point data record format (bit 7 set = LAZ)
 *   105  u16              point data record length (may exceed the format's
 *                         size: extra bytes ride at the end of every record)
 *   107  u32              legacy number of point records (0 in a 1.4 file
 *                         whose count needs 64 bits)
 *   131  f64 ×3           x, y, z scale
 *   155  f64 ×3           x, y, z offset
 *   179  f64 ×6           max x, min x, max y, min y, max z, min z
 *   247  u64              number of point records (1.4)
 * Coordinates are stored as i32 and reconstructed as `raw * scale + offset`,
 * which is why positions are rebased to a double-precision origin here.
 *
 * Point record: X, Y, Z i32 at 0/4/8, intensity u16 at 12, the return byte at
 * 14, then per format:
 *   0–5   classification at 15 (low 5 bits), GPS time f64 at 20 (1,3,4,5),
 *         RGB u16×3 at 20 (2) or 28 (3,5)
 *   6–10  classification u8 at 16, GPS time f64 at 22, RGB at 30 (7,8,10),
 *         NIR u16 at 36 (8,10)
 * Return number is 3 bits (0–5) or 4 bits (6–10) of the return byte.
 *
 * VLRs (54-byte header each: u16 reserved, char[16] user id, u16 record id,
 * u16 length after header, char[32] description) follow the header. Two are
 * read: LASF_Projection 34735 (the GeoTIFF key directory — ProjectedCSTypeGeoKey
 * 3072 carries the EPSG code, UTM zones being 326xx/327xx) and 2112 (an OGC
 * WKT string), for the CRS / UTM metadata the basemap needs.
 */
import type { PointAttribute, PointCloudData } from './types';

export class LasError extends Error {
  constructor(message: string) {
    super(`LAS: ${message}`);
    this.name = 'LasError';
  }
}

interface LasHeader {
  version: string;
  systemIdentifier: string;
  software: string;
  headerSize: number;
  offsetToPoints: number;
  vlrCount: number;
  format: number;
  compressed: boolean;
  recordLength: number;
  count: number;
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
}

/** Bytes of each point record format's fixed part (extra bytes may follow). */
const FORMAT_SIZE: Record<number, number> = {
  0: 20,
  1: 28,
  2: 26,
  3: 34,
  4: 57,
  5: 63,
  6: 30,
  7: 36,
  8: 38,
  9: 59,
  10: 67,
};

/** Field offsets inside a point record, per format (see the layout notes above). */
function fieldOffsets(format: number) {
  const modern = format >= 6;
  const gps = modern ? 22 : [1, 3, 4, 5].includes(format) ? 20 : -1;
  const rgb = format === 2 ? 20 : format === 3 || format === 5 ? 28 : format >= 7 ? 30 : -1;
  const nir = format === 8 || format === 10 ? 36 : -1;
  return { modern, gps, rgb, nir, classification: modern ? 16 : 15 };
}

function ascii(view: DataView, at: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = view.getUint8(at + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function readHeader(view: DataView): LasHeader {
  if (view.byteLength < 227) throw new LasError('file too short for a LAS header');
  if (ascii(view, 0, 4) !== 'LASF') throw new LasError('not a LAS file (no LASF signature)');
  const major = view.getUint8(24);
  const minor = view.getUint8(25);
  if (major !== 1 || minor > 4) throw new LasError(`unsupported version ${major}.${minor}`);
  const headerSize = view.getUint16(94, true);
  const offsetToPoints = view.getUint32(96, true);
  const vlrCount = view.getUint32(100, true);
  const formatByte = view.getUint8(104);
  const format = formatByte & 0x3f;
  const recordLength = view.getUint16(105, true);
  let count = view.getUint32(107, true);
  const f64 = (at: number) => view.getFloat64(at, true);
  const scale: [number, number, number] = [f64(131), f64(139), f64(147)];
  const offset: [number, number, number] = [f64(155), f64(163), f64(171)];
  const max: [number, number, number] = [f64(179), f64(195), f64(211)];
  const min: [number, number, number] = [f64(187), f64(203), f64(219)];
  if (minor >= 4 && headerSize >= 375) {
    // 1.4: the 64-bit count is authoritative; the legacy field is 0 past 2^32 points.
    const lo = view.getUint32(247, true);
    const hi = view.getUint32(251, true);
    const count64 = hi * 2 ** 32 + lo;
    if (count64 > 0) count = count64;
  }
  if (!(format in FORMAT_SIZE)) throw new LasError(`unsupported point data record format ${format}`);
  if (recordLength < FORMAT_SIZE[format])
    throw new LasError(`point record length ${recordLength} is shorter than format ${format}'s ${FORMAT_SIZE[format]} bytes`);
  return {
    version: `${major}.${minor}`,
    systemIdentifier: ascii(view, 26, 32),
    software: ascii(view, 58, 32),
    headerSize,
    offsetToPoints,
    vlrCount,
    format,
    compressed: (formatByte & 0x80) !== 0,
    recordLength,
    count,
    scale,
    offset,
    min,
    max,
  };
}

interface Projection {
  epsg?: number;
  wkt?: string;
  laszip: boolean;
}

/** Walk the VLRs for the projection records (and the LASzip marker). Lenient: a
 *  malformed VLR block ends the walk, it never fails the parse. */
function readVlrs(view: DataView, h: LasHeader): Projection {
  const out: Projection = { laszip: false };
  let at = h.headerSize;
  for (let i = 0; i < h.vlrCount; i++) {
    if (at + 54 > view.byteLength) break;
    const userId = ascii(view, at + 2, 16);
    const recordId = view.getUint16(at + 18, true);
    const len = view.getUint16(at + 20, true);
    const body = at + 54;
    if (body + len > view.byteLength) break;
    if (userId === 'laszip encoded' && recordId === 22204) out.laszip = true;
    if (userId === 'LASF_Projection' && recordId === 34735 && len >= 8) {
      // GeoKeyDirectory: 4 u16 header (version, revision, minor, count), then u16 quadruples
      // (key id, TIFF tag location, count, value/offset); value is inline when location is 0.
      const n = view.getUint16(body + 6, true);
      for (let k = 0; k < n && body + 8 + k * 8 + 8 <= body + len; k++) {
        const e = body + 8 + k * 8;
        const key = view.getUint16(e, true);
        const loc = view.getUint16(e + 2, true);
        const value = view.getUint16(e + 6, true);
        if (key === 3072 && loc === 0 && value !== 0 && value !== 32767) out.epsg = value; // ProjectedCSTypeGeoKey
      }
    }
    if (userId === 'LASF_Projection' && recordId === 2112) out.wkt = ascii(view, body, len);
    at = body + len;
  }
  return out;
}

/** UTM zone / hemisphere from an EPSG code (WGS84 UTM: 32601–32660 N, 32701–32760 S) or a WKT
 *  name ("... UTM zone 18N ..."). */
export function utmFrom(proj: { epsg?: number; wkt?: string }): { zone: number; south: boolean } | undefined {
  const e = proj.epsg;
  if (e !== undefined) {
    if (e >= 32601 && e <= 32660) return { zone: e - 32600, south: false };
    if (e >= 32701 && e <= 32760) return { zone: e - 32700, south: true };
  }
  const m = proj.wkt?.match(/UTM[ _]zone[ _](\d{1,2})\s*([NS])?/i);
  if (m) return { zone: Number(m[1]), south: (m[2] ?? 'N').toUpperCase() === 'S' };
  return undefined;
}

export function parseLas(buffer: ArrayBuffer, name = 'las'): PointCloudData {
  const view = new DataView(buffer);
  const h = readHeader(view);
  const proj = readVlrs(view, h);
  if (h.compressed || proj.laszip)
    throw new LasError(
      `${name} is LAZ-compressed, which this viewer cannot decode — convert it first ` +
        `(pdal translate in.laz out.las, or laszip -i in.laz -o out.las)`,
    );
  const stride = h.recordLength;
  const available = Math.floor(Math.max(0, view.byteLength - h.offsetToPoints) / stride);
  let n = h.count;
  if (n === 0) n = available; // a writer that never filled the count in: read what is there
  if (n > available)
    throw new LasError(`truncated: header declares ${n} points, the file holds ${available} (${view.byteLength} bytes)`);

  const f = fieldOffsets(h.format);
  const [sx, sy, sz] = h.scale;
  const [ox, oy, oz] = h.offset;
  // Origin: the declared bounds' midpoint when a writer set them, else the first point.
  const declared = h.min.every((v, i) => Number.isFinite(v) && Number.isFinite(h.max[i]) && v <= h.max[i]);
  let origin: [number, number, number];
  if (declared) origin = [(h.min[0] + h.max[0]) / 2, (h.min[1] + h.max[1]) / 2, (h.min[2] + h.max[2]) / 2];
  else if (n > 0) {
    const p = h.offsetToPoints;
    origin = [view.getInt32(p, true) * sx + ox, view.getInt32(p + 4, true) * sy + oy, view.getInt32(p + 8, true) * sz + oz];
  } else origin = [0, 0, 0];

  const positions = new Float32Array(n * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const intensity = new Float32Array(n);
  const classification = new Float32Array(n);
  const returnNumber = new Float32Array(n);
  const gpsTime = f.gps >= 0 ? new Float32Array(n) : null;
  const red = f.rgb >= 0 ? new Float32Array(n) : null;
  const green = f.rgb >= 0 ? new Float32Array(n) : null;
  const blue = f.rgb >= 0 ? new Float32Array(n) : null;
  const nir = f.nir >= 0 ? new Float32Array(n) : null;
  // GPS time is a double (seconds, often ~1e9 of them): keep it float32-exact as an offset from
  // the first point's stamp, the attribute's `offset` restoring the absolute value.
  let gpsOffset = 0;
  if (gpsTime && n > 0) gpsOffset = view.getFloat64(h.offsetToPoints + f.gps, true);

  for (let i = 0; i < n; i++) {
    const p = h.offsetToPoints + i * stride;
    // fround: the bounds must describe the float32 positions as STORED, not the doubles they came from
    const lx = Math.fround(view.getInt32(p, true) * sx + ox - origin[0]);
    const ly = Math.fround(view.getInt32(p + 4, true) * sy + oy - origin[1]);
    const lz = Math.fround(view.getInt32(p + 8, true) * sz + oz - origin[2]);
    positions[i * 3] = lx;
    positions[i * 3 + 1] = ly;
    positions[i * 3 + 2] = lz;
    if (lx < min[0]) min[0] = lx;
    if (ly < min[1]) min[1] = ly;
    if (lz < min[2]) min[2] = lz;
    if (lx > max[0]) max[0] = lx;
    if (ly > max[1]) max[1] = ly;
    if (lz > max[2]) max[2] = lz;
    intensity[i] = view.getUint16(p + 12, true);
    const ret = view.getUint8(p + 14);
    returnNumber[i] = f.modern ? ret & 0x0f : ret & 0x07;
    const cls = view.getUint8(p + f.classification);
    classification[i] = f.modern ? cls : cls & 0x1f;
    if (gpsTime) gpsTime[i] = view.getFloat64(p + f.gps, true) - gpsOffset;
    if (red && green && blue) {
      red[i] = view.getUint16(p + f.rgb, true);
      green[i] = view.getUint16(p + f.rgb + 2, true);
      blue[i] = view.getUint16(p + f.rgb + 4, true);
    }
    if (nir) nir[i] = view.getUint16(p + f.nir, true);
  }
  if (n === 0) min.fill(0), max.fill(0);

  const attributes: PointAttribute[] = [];
  const attr = (name: string, values: Float32Array | null, offset = 0) => {
    if (!values) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo > hi) (lo = 0), (hi = 0);
    attributes.push({ name, values, offset, min: lo + offset, max: hi + offset });
  };
  attr('intensity', intensity);
  attr('classification', classification);
  attr('return_number', returnNumber);
  attr('gps_time', gpsTime, gpsOffset);
  attr('red', red);
  attr('green', green);
  attr('blue', blue);
  attr('nir', nir);

  const utm = utmFrom(proj);
  const crs = utm
    ? `UTM zone ${utm.zone}${utm.south ? 'S' : 'N'}${proj.epsg ? ` (EPSG:${proj.epsg})` : ''}`
    : proj.epsg
      ? `EPSG:${proj.epsg}`
      : proj.wkt
        ? proj.wkt.slice(0, 80)
        : undefined;

  return {
    count: n,
    positions,
    origin,
    localBounds: { min, max },
    attributes,
    crs,
    utm,
    source: {
      format: 'las',
      version: h.version,
      pointFormat: h.format,
      recordLength: h.recordLength,
      systemIdentifier: h.systemIdentifier,
      software: h.software,
      epsg: proj.epsg,
    },
  };
}
