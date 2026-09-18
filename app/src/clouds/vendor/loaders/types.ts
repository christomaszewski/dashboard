/**
 * Normalized in-memory representation every format loader produces.
 *
 * Positions are float32 *relative to `origin`* — geospatial formats carry
 * UTM/ECEF-magnitude coordinates that don't survive a float32 cast, so the
 * loader rebases them and keeps the double-precision origin as metadata.
 * Absolute coordinate of point i = origin + positions[3i..3i+2].
 */
export interface PointAttribute {
  name: string;
  /** Raw stored values; absolute value = raw + offset. */
  values: Float32Array;
  offset: number;
  /** Absolute range (offset applied), computed from the data. */
  min: number;
  max: number;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface PointCloudData {
  count: number;
  /** 3 * count floats, origin-relative. */
  positions: Float32Array;
  origin: [number, number, number];
  /** Bounds of `positions` (origin-relative). */
  localBounds: Bounds;
  attributes: PointAttribute[];
  /** Human-readable CRS description, e.g. "UTM zone 18N (WGS84)". */
  crs?: string;
  /** Structured georeference, when the cloud is in UTM coordinates. */
  utm?: { zone: number; south: boolean };
  /** Format-specific extras (header fields, timings, …). */
  source: Record<string, unknown> & { format: string };
}

/** Buffers to hand to postMessage() as transferables. */
export function transferables(data: PointCloudData): ArrayBuffer[] {
  const bufs = new Set<ArrayBuffer>();
  bufs.add(data.positions.buffer as ArrayBuffer);
  for (const a of data.attributes) bufs.add(a.values.buffer as ArrayBuffer);
  return [...bufs];
}
