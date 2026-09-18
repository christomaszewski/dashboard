import { describe, expect, it } from 'vitest';
import { LasError, parseLas, utmFrom } from './loaders/las';
import { parseFile, supportedExtensions } from './loaders';
// @ts-expect-error plain-JS test helper, outside tsc's include
import { writeLas } from './lasWrite.mjs';

const N = 500;
const SCALE: [number, number, number] = [0.001, 0.001, 0.001];
const OFFSET: [number, number, number] = [500000, 4400000, 100];

/** Deterministic test cloud on a ~100 m UTM tile, with every per-point field a format can carry. */
function testPoints() {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pts = [];
  for (let i = 0; i < N; i++) {
    pts.push({
      x: 500000 + Math.round(rand() * 100000) / 1000,
      y: 4400000 + Math.round(rand() * 100000) / 1000,
      z: 120 + Math.round(rand() * 30000) / 1000,
      intensity: Math.floor(rand() * 65536),
      classification: [1, 2, 5, 6, 9][i % 5],
      returnNumber: 1 + (i % 5),
      gpsTime: 1.2e9 + i * 0.001,
      red: (i * 131) % 65536,
      green: (i * 257) % 65536,
      blue: (i * 383) % 65536,
      nir: (i * 41) % 65536,
    });
  }
  return pts;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const attr = (data: ReturnType<typeof parseLas>, name: string) => data.attributes.find((a) => a.name === name);

function expectPositions(data: ReturnType<typeof parseLas>, pts = testPoints()) {
  expect(data.count).toBe(N);
  for (const i of [0, 1, 17, N - 1]) {
    // absolute = origin + local; the stored i32 * 0.001 scale is exact to the millimetre
    expect(data.origin[0] + data.positions[i * 3]).toBeCloseTo(pts[i].x, 2);
    expect(data.origin[1] + data.positions[i * 3 + 1]).toBeCloseTo(pts[i].y, 2);
    expect(data.origin[2] + data.positions[i * 3 + 2]).toBeCloseTo(pts[i].z, 2);
  }
  // bounds are tight around the local positions
  const { min, max } = data.localBounds;
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < 3; k++) {
      expect(data.positions[i * 3 + k]).toBeGreaterThanOrEqual(min[k]);
      expect(data.positions[i * 3 + k]).toBeLessThanOrEqual(max[k]);
    }
  }
}

describe('parseLas', () => {
  it('format 0 in a 1.2 file: positions through scale/offset, origin at the declared bounds midpoint, the base attributes', () => {
    const pts = testPoints();
    const data = parseLas(toBuffer(writeLas({ points: pts, scale: SCALE, offset: OFFSET })), 'tile.las');
    expectPositions(data, pts);
    const xs = pts.map((p) => p.x);
    expect(data.origin[0]).toBeCloseTo((Math.min(...xs) + Math.max(...xs)) / 2, 6);
    expect(data.attributes.map((a) => a.name)).toEqual(['intensity', 'classification', 'return_number']);
    expect(attr(data, 'intensity')!.values[17]).toBe(pts[17].intensity);
    expect(attr(data, 'classification')!.values[3]).toBe(pts[3].classification);
    expect(attr(data, 'return_number')!.values[4]).toBe(pts[4].returnNumber);
    expect(attr(data, 'intensity')!.max).toBe(Math.max(...pts.map((p) => p.intensity)));
    expect(data.source).toMatchObject({ format: 'las', version: '1.2', pointFormat: 0, recordLength: 20 });
    expect(data.utm).toBeUndefined();
    expect(data.crs).toBeUndefined();
  });

  it('format 3 carries GPS time (float32-exact through its offset) and RGB', () => {
    const pts = testPoints();
    const data = parseLas(toBuffer(writeLas({ format: 3, points: pts, scale: SCALE, offset: OFFSET })));
    expectPositions(data, pts);
    expect(data.attributes.map((a) => a.name)).toEqual(['intensity', 'classification', 'return_number', 'gps_time', 'red', 'green', 'blue']);
    const t = attr(data, 'gps_time')!;
    expect(t.offset).toBe(pts[0].gpsTime);
    expect(t.values[0] + t.offset).toBeCloseTo(pts[0].gpsTime, 3);
    expect(t.values[N - 1] + t.offset).toBeCloseTo(pts[N - 1].gpsTime, 3);
    expect(t.min).toBeCloseTo(pts[0].gpsTime, 3);
    expect(attr(data, 'red')!.values[9]).toBe(pts[9].red);
    expect(attr(data, 'green')!.values[9]).toBe(pts[9].green);
    expect(attr(data, 'blue')!.values[9]).toBe(pts[9].blue);
  });

  it('format 8 in a 1.4 file whose legacy count is 0: the 64-bit count, the classification byte, 4-bit returns, NIR', () => {
    const pts = testPoints();
    const data = parseLas(toBuffer(writeLas({ version: [1, 4], format: 8, points: pts, scale: SCALE, offset: OFFSET, legacyCountZero: true })));
    expectPositions(data, pts);
    expect(data.source.version).toBe('1.4');
    expect(attr(data, 'classification')!.values[3]).toBe(pts[3].classification);
    expect(attr(data, 'return_number')!.values[4]).toBe(pts[4].returnNumber);
    expect(attr(data, 'gps_time')!.values[5] + attr(data, 'gps_time')!.offset).toBeCloseTo(pts[5].gpsTime, 3);
    expect(attr(data, 'nir')!.values[6]).toBe(pts[6].nir);
    expect(attr(data, 'red')!.values[6]).toBe(pts[6].red);
  });

  it('extra bytes on every record are stepped over', () => {
    const pts = testPoints();
    const data = parseLas(toBuffer(writeLas({ format: 1, points: pts, scale: SCALE, offset: OFFSET, extraBytes: 7 })));
    expectPositions(data, pts);
    expect(data.source.recordLength).toBe(35);
    expect(attr(data, 'gps_time')!.values[N - 1] + attr(data, 'gps_time')!.offset).toBeCloseTo(pts[N - 1].gpsTime, 3);
  });

  it('UTM comes from the GeoKey EPSG code or the WKT name', () => {
    const pts = testPoints().slice(0, 10);
    const byEpsg = parseLas(toBuffer(writeLas({ points: pts, epsg: 32618 })));
    expect(byEpsg.utm).toEqual({ zone: 18, south: false });
    expect(byEpsg.crs).toBe('UTM zone 18N (EPSG:32618)');
    const byWkt = parseLas(toBuffer(writeLas({ points: pts, wkt: 'PROJCS["WGS 84 / UTM zone 33S",GEOGCS["WGS 84"]]' })));
    expect(byWkt.utm).toEqual({ zone: 33, south: true });
    expect(byWkt.crs).toBe('UTM zone 33S');
    expect(utmFrom({ epsg: 32756 })).toEqual({ zone: 56, south: true });
    expect(utmFrom({ epsg: 4326 })).toBeUndefined();
    expect(utmFrom({ wkt: 'PROJCS["NAD83 / UTM zone 17N"]' })).toEqual({ zone: 17, south: false });
    expect(parseLas(toBuffer(writeLas({ points: pts, epsg: 3857 }))).crs).toBe('EPSG:3857');
  });

  it('with no declared bounds the origin is the first point', () => {
    const pts = testPoints().slice(0, 10);
    const data = parseLas(toBuffer(writeLas({ points: pts, scale: SCALE, offset: OFFSET, noBounds: true })));
    expect(data.origin[0]).toBeCloseTo(pts[0].x, 2);
    expect(data.positions[0]).toBeCloseTo(0, 5);
    expectPositionsSubset(data, pts);
  });

  it('LAZ is refused with a conversion hint', () => {
    const pts = testPoints().slice(0, 10);
    expect(() => parseLas(toBuffer(writeLas({ points: pts, laz: true })), 'a.laz')).toThrow(/LAZ-compressed.*pdal translate/);
    expect(() => parseLas(toBuffer(writeLas({ points: pts, laz: true })))).toThrow(LasError);
  });

  it('truncated and foreign files fail loudly', () => {
    const pts = testPoints().slice(0, 10);
    const whole = writeLas({ points: pts });
    expect(() => parseLas(toBuffer(whole.slice(0, whole.length - 5)))).toThrow(/truncated: header declares 10 points, the file holds 9/);
    expect(() => parseLas(toBuffer(writeLas({ points: pts, declaredCount: 50 })))).toThrow(/truncated/);
    expect(() => parseLas(new ArrayBuffer(100))).toThrow(/too short/);
    const bpf = new Uint8Array(300);
    [0x42, 0x50, 0x46, 0x21].forEach((b, i) => (bpf[i] = b)); // "BPF!"
    expect(() => parseLas(toBuffer(bpf))).toThrow(/not a LAS file/);
  });

  it('a count of 0 in the header reads whatever the file holds', () => {
    const pts = testPoints().slice(0, 10);
    const data = parseLas(toBuffer(writeLas({ points: pts, declaredCount: 0 })));
    expect(data.count).toBe(10);
  });

  it('is registered as .las, case-insensitively', async () => {
    expect(supportedExtensions()).toContain('las');
    const data = await parseFile('SCAN.LAS', toBuffer(writeLas({ points: testPoints().slice(0, 3) })));
    expect(data.count).toBe(3);
  });
});

function expectPositionsSubset(data: ReturnType<typeof parseLas>, pts: ReturnType<typeof testPoints>) {
  for (let i = 0; i < pts.length; i++) {
    expect(data.origin[0] + data.positions[i * 3]).toBeCloseTo(pts[i].x, 2);
    expect(data.origin[2] + data.positions[i * 3 + 2]).toBeCloseTo(pts[i].z, 2);
  }
}
