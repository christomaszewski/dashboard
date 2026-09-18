import { describe, expect, it } from 'vitest';
import {
  latToTileY,
  lonLatToUtm,
  lonToTileX,
  pickZoom,
  tileToLonLat,
  utmCentralMeridian,
  utmToLonLat,
} from './core/utm';

describe('UTM ↔ WGS84', () => {
  it('round-trips to sub-centimeter across zones and hemispheres', () => {
    for (const zone of [1, 18, 31, 60]) {
      const cm = utmCentralMeridian(zone);
      for (const south of [false, true]) {
        for (const lat of south ? [-72, -33.9, -1] : [0.5, 39.7, 71.2]) {
          for (const dLon of [-2.9, -0.4, 0, 1.7]) {
            const [e, n] = lonLatToUtm(cm + dLon, lat, zone, south);
            const [lon2, lat2] = utmToLonLat(e, n, zone, south);
            // 1e-7 deg ≈ 1 cm
            expect(lon2).toBeCloseTo(cm + dLon, 7);
            expect(lat2).toBeCloseTo(lat, 7);
          }
        }
      }
    }
  });

  it('puts the central meridian at easting 500000', () => {
    for (const lat of [-60, 0, 45, 80]) {
      const [e] = lonLatToUtm(utmCentralMeridian(18), lat, 18, lat < 0);
      expect(e).toBeCloseTo(500000, 6);
    }
  });

  it('matches the analytic equator scale (k0 · a · Δλ)', () => {
    // At the equator, easting offset for a small Δλ is k0 · a · Δλ.
    const dLonDeg = 0.01;
    const expected = 0.9996 * 6378137 * ((dLonDeg * Math.PI) / 180);
    const [e, n] = lonLatToUtm(utmCentralMeridian(31) + dLonDeg, 0, 31, false);
    expect(e - 500000).toBeCloseTo(expected, 2);
    expect(n).toBeCloseTo(0, 6);
  });

  it('applies the southern false northing', () => {
    const [, n] = lonLatToUtm(utmCentralMeridian(56) + 1, -33.9, 56, true);
    expect(n).toBeGreaterThan(6_000_000);
    expect(n).toBeLessThan(10_000_000);
  });

  it('zone central meridians', () => {
    expect(utmCentralMeridian(1)).toBe(-177);
    expect(utmCentralMeridian(18)).toBe(-75);
    expect(utmCentralMeridian(31)).toBe(3);
    expect(utmCentralMeridian(60)).toBe(177);
  });
});

describe('slippy tile math', () => {
  it('tile corners at low zoom', () => {
    expect(tileToLonLat(0, 0, 0)[0]).toBeCloseTo(-180, 9);
    expect(tileToLonLat(0, 0, 0)[1]).toBeCloseTo(85.0511, 3);
    const [lon, lat] = tileToLonLat(1, 1, 1);
    expect(lon).toBeCloseTo(0, 9);
    expect(lat).toBeCloseTo(0, 9);
  });

  it('tile indexing inverts the corner mapping', () => {
    const z = 15;
    const [lon, lat] = tileToLonLat(9648, 12305, z);
    expect(lonToTileX(lon, z)).toBeCloseTo(9648, 6);
    expect(latToTileY(lat, z)).toBeCloseTo(12305, 6);
  });

  it('picks sane zooms', () => {
    const z = pickZoom(400, 40, 19); // ~400 m scene at mid-latitude
    expect(z).toBeGreaterThanOrEqual(17);
    expect(z).toBeLessThanOrEqual(19);
    expect(pickZoom(5_000_000, 0, 19)).toBe(5); // continent scale
    expect(pickZoom(10, 0, 19)).toBe(19); // clamped
  });
});
