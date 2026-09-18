/** Browser-fetched XYZ layers. Keep providers and their attribution together when switching. */
export type BasemapId = "streets" | "satellite" | "terrain" | "none" | "custom";
export interface Basemap {
  id: BasemapId;
  label: string;
  tiles?: string;
  attribution?: string;
  maxNativeZoom?: number;
}

const BUILTINS: readonly Basemap[] = [
  {
    id: "streets", label: "Streets",
    tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    maxNativeZoom: 19,
  },
  {
    id: "satellite", label: "Satellite",
    tiles: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: 'Imagery © <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community',
    maxNativeZoom: 19,
  },
  {
    id: "terrain", label: "Terrain",
    tiles: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: 'Tiles © <a href="https://www.esri.com/">Esri</a> — Esri, HERE, Garmin, USGS, Intermap, and the GIS User Community',
    maxNativeZoom: 19,
  },
  { id: "none", label: "None" },
];

type Options = { basemap?: BasemapId; tiles?: string; attribution?: string };

export function mapLayers(widget: Options): readonly Basemap[] {
  if (!widget.tiles || widget.tiles === "none") return BUILTINS;
  const provider = BUILTINS.find(layer => layer.tiles === widget.tiles);
  return [...BUILTINS, {
    ...provider, id: "custom", label: "Custom", tiles: widget.tiles,
    attribution: widget.attribution ?? provider?.attribution,
  }];
}

/** An explicit default wins; old custom/offline configurations keep their original behavior. */
export function defaultBasemap(widget: Options): BasemapId {
  return widget.basemap ?? (widget.tiles === "none" ? "none" : widget.tiles ? "custom" : "streets");
}
