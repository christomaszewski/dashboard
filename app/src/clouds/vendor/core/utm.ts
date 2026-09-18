/**
 * WGS84 ↔ UTM conversion using the Krüger series in Karney's formulation
 * (order n³), accurate to well under a millimeter anywhere inside a zone —
 * plenty for draping map tiles under a cloud.
 */

const DEG = Math.PI / 180;
const A = 6378137; // WGS84 semi-major axis
const F = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_EASTING = 500000;
const FALSE_NORTHING_SOUTH = 10_000_000;

const n = F / (2 - F);
const RECT_A = (A / (1 + n)) * (1 + (n * n) / 4 + (n * n * n * n) / 64);
const ALPHA = [
  n / 2 - (2 / 3) * n ** 2 + (5 / 16) * n ** 3,
  (13 / 48) * n ** 2 - (3 / 5) * n ** 3,
  (61 / 240) * n ** 3,
];
const BETA = [
  n / 2 - (2 / 3) * n ** 2 + (37 / 96) * n ** 3,
  (1 / 48) * n ** 2 + (1 / 15) * n ** 3,
  (17 / 480) * n ** 3,
];
const DELTA = [
  2 * n - (2 / 3) * n ** 2 - 2 * n ** 3,
  (7 / 3) * n ** 2 - (8 / 5) * n ** 3,
  (56 / 15) * n ** 3,
];

export function utmCentralMeridian(zone: number): number {
  return (zone - 1) * 6 - 180 + 3; // degrees
}

/** [lon, lat] degrees → [easting, northing] meters in the given zone. */
export function lonLatToUtm(lon: number, lat: number, zone: number, south: boolean): [number, number] {
  const phi = lat * DEG;
  let lam = (lon - utmCentralMeridian(zone)) * DEG;
  lam = ((lam + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

  const sinPhi = Math.sin(phi);
  const c = (2 * Math.sqrt(n)) / (1 + n);
  const t = Math.sinh(Math.atanh(sinPhi) - c * Math.atanh(c * sinPhi));
  const xiP = Math.atan2(t, Math.cos(lam));
  const etaP = Math.asinh(Math.sin(lam) / Math.hypot(t, Math.cos(lam)));

  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 3; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }

  const easting = FALSE_EASTING + K0 * RECT_A * eta;
  let northing = K0 * RECT_A * xi;
  if (south) northing += FALSE_NORTHING_SOUTH;
  return [easting, northing];
}

/** [easting, northing] meters in the given zone → [lon, lat] degrees. */
export function utmToLonLat(easting: number, northing: number, zone: number, south: boolean): [number, number] {
  if (south) northing -= FALSE_NORTHING_SOUTH;
  const xi = northing / (K0 * RECT_A);
  const eta = (easting - FALSE_EASTING) / (K0 * RECT_A);

  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 3; j++) {
    xiP -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }

  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  const lam = Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  return [utmCentralMeridian(zone) + lam / DEG, phi / DEG];
}

// --- Web-Mercator (slippy map) tile helpers ---

/** Top-left corner of tile (x, y) at zoom z, as [lon, lat] degrees. */
export function tileToLonLat(x: number, y: number, z: number): [number, number] {
  const k = Math.pow(2, z);
  const lon = (x / k) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / k))) / DEG;
  return [lon, lat];
}

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

export function latToTileY(lat: number, z: number): number {
  const phi = lat * DEG;
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * Math.pow(2, z);
}

/**
 * Zoom level whose tiles span roughly spanMeters / targetTiles on the ground
 * at the given latitude, clamped to [3, maxZoom].
 */
export function pickZoom(spanMeters: number, lat: number, maxZoom: number, targetTiles = 4): number {
  const equator = 40_075_016.686;
  const z = Math.round(Math.log2((equator * Math.cos(lat * DEG) * targetTiles) / Math.max(spanMeters, 1)));
  return Math.min(Math.max(z, 3), maxZoom);
}
