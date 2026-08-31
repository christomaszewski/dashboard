/**
 * Drapes web map tiles (satellite / street) under a georeferenced cloud so
 * alignment with reality can be checked visually. Tiles are Web-Mercator;
 * each tile quad is placed by projecting its 4 corner lon/lats into the
 * cloud's UTM zone, which absorbs grid convergence and scale differences at
 * the accuracy that matters for a viewer.
 */
import * as THREE from 'three';
import type { PointCloudData } from '../loaders/types';
import { latToTileY, lonLatToUtm, lonToTileX, pickZoom, tileToLonLat, utmToLonLat } from './utm';

export type BasemapId = 'satellite' | 'streets';

export const BASEMAPS: Record<BasemapId, { label: string; url: (z: number, x: number, y: number) => string; attribution: string; maxZoom: number }> = {
  satellite: {
    label: 'Satellite',
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  },
  streets: {
    label: 'Streets',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  },
};

const MAX_TILES_PER_AXIS = 10;

export class BasemapLayer {
  readonly group = new THREE.Group();
  private disposed = false;

  /**
   * @param onTileError invoked once per failed tile (offline, zoom not
   *   covered here, …); the rest of the layer still renders.
   */
  constructor(
    data: PointCloudData,
    id: BasemapId,
    anisotropy: number,
    private onTileError?: (failed: number) => void,
  ) {
    const utm = data.utm;
    if (!utm) throw new Error('cloud has no UTM georeference');
    const map = BASEMAPS[id];

    const { min, max } = data.localBounds;
    const [ox, oy] = data.origin;
    const spanX = max[0] - min[0];
    const spanY = max[1] - min[1];
    const margin = Math.max(0.35 * Math.max(spanX, spanY), 30);
    const minE = ox + min[0] - margin;
    const maxE = ox + max[0] + margin;
    const minN = oy + min[1] - margin;
    const maxN = oy + max[1] + margin;

    // Footprint in lon/lat (corner-project both diagonals to be safe).
    const corners = [
      utmToLonLat(minE, minN, utm.zone, utm.south),
      utmToLonLat(maxE, minN, utm.zone, utm.south),
      utmToLonLat(minE, maxN, utm.zone, utm.south),
      utmToLonLat(maxE, maxN, utm.zone, utm.south),
    ];
    const lons = corners.map((c) => c[0]);
    const lats = corners.map((c) => c[1]);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;

    const zoom = pickZoom(Math.max(maxE - minE, maxN - minN), midLat, map.maxZoom);
    let x0 = Math.floor(lonToTileX(Math.min(...lons), zoom));
    let x1 = Math.floor(lonToTileX(Math.max(...lons), zoom));
    let y0 = Math.floor(latToTileY(Math.max(...lats), zoom)); // tile y grows southward
    let y1 = Math.floor(latToTileY(Math.min(...lats), zoom));
    x1 = Math.min(x1, x0 + MAX_TILES_PER_AXIS - 1);
    y1 = Math.min(y1, y0 + MAX_TILES_PER_AXIS - 1);

    // Sit the imagery just below the lowest returns to avoid z-fighting.
    const zRange = max[2] - min[2];
    const groundZ = min[2] - Math.max(0.02 * zRange, 0.3);

    const loader = new THREE.TextureLoader();
    let failed = 0;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const geometry = this.tileGeometry(tx, ty, zoom, utm, ox, oy, groundZ);
        const texture = loader.load(
          map.url(zoom, tx, ty),
          undefined,
          undefined,
          () => this.onTileError?.(++failed),
        );
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = anisotropy;
        const material = new THREE.MeshBasicMaterial({ map: texture });
        this.group.add(new THREE.Mesh(geometry, material));
      }
    }
  }

  /** Quad for one tile, corners projected lon/lat → UTM → cloud-local. */
  private tileGeometry(
    tx: number,
    ty: number,
    zoom: number,
    utm: { zone: number; south: boolean },
    ox: number,
    oy: number,
    z: number,
  ): THREE.BufferGeometry {
    const local = (x: number, y: number): [number, number] => {
      const [lon, lat] = tileToLonLat(x, y, zoom);
      const [e, n] = lonLatToUtm(lon, lat, utm.zone, utm.south);
      return [e - ox, n - oy];
    };
    const nw = local(tx, ty);
    const ne = local(tx + 1, ty);
    const sw = local(tx, ty + 1);
    const se = local(tx + 1, ty + 1);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [sw[0], sw[1], z, se[0], se[1], z, nw[0], nw[1], z, ne[0], ne[1], z],
        3,
      ),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    return geometry;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.group.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.map?.dispose();
      material.dispose();
    }
    this.group.clear();
  }
}
