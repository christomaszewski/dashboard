import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { mapFeeds, type MapWidgetConfig } from "../mapConfig";
import type { MapPosition } from "../geo";
import { defaultBasemap, mapLayers, type BasemapId } from "../basemaps";
import { MapFeedLayer } from "./MapFeedLayer";

const FEED_COLORS = ["#38bdf8", "#fbbf24", "#c084fc", "#34d399", "#fb7185"];

/** Independent position/heading layers share one map; tiles are fetched by the viewing browser. */
export function MapWidget({ widget }: { widget: MapWidgetConfig }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  const initialized = useRef(false);
  const focusPending = useRef(false);
  const feeds = useMemo(() => mapFeeds(widget), [widget]);
  const label = widget.label ?? widget.topic ?? "Position";
  const [visible, setVisible] = useState(() => new Set(feeds.filter(f => f.visible !== false).map(f => f.id)));
  const [selected, setSelected] = useState(() => widget.default_feed ?? feeds.find(f => f.visible !== false)?.id ?? "");
  const [positions, setPositions] = useState(() => new Map<string, MapPosition>());
  const [statuses, setStatuses] = useState(() => new Map<string, string>());
  const [paused, setPaused] = useState(false);
  const [basemap, setBasemap] = useState(() => defaultBasemap(widget));
  const zoom = Math.min(22, Math.max(2, widget.zoom ?? 17));
  const follow = widget.follow ?? true;
  const trailMax = Math.max(0, Math.floor(widget.trail ?? 500));
  const layers = mapLayers(widget);
  const layer = layers.find(l => l.id === basemap)!;
  const activePosition = visible.has(selected) ? positions.get(selected) : undefined;
  const firstPosition = feeds.find(f => visible.has(f.id) && positions.has(f.id));
  const firstFix = firstPosition ? positions.get(firstPosition.id) : undefined;

  // Map lifetime == widget mount (Home stays mounted across tab switches).
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const instance = L.map(el, { attributionControl: false, center: [0, 0], zoom, minZoom: 2, maxZoom: 22 });
    L.control.attribution({ prefix: false }).addTo(instance);
    initialized.current = false;
    instance.on("dragstart", () => { focusPending.current = false; setPaused(true); });
    const observer = new ResizeObserver(() => { if (el.clientWidth > 0) instance.invalidateSize(); });
    observer.observe(el);
    setMap(instance);
    return () => { observer.disconnect(); instance.remove(); };
    // Config values are fixed for a mounted widget; changing layers never rebuilds the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!map || !layer.tiles) return;
    const tiles = L.tileLayer(layer.tiles, {
      maxZoom: 22, maxNativeZoom: layer.maxNativeZoom, attribution: layer.attribution,
    }).addTo(map);
    return () => { tiles.remove(); };
  }, [map, layer.tiles, layer.attribution, layer.maxNativeZoom]);

  const onPosition = useCallback((id: string, pos: MapPosition) => {
    setPositions(prev => prev.get(id)?.lat === pos.lat && prev.get(id)?.lon === pos.lon ? prev : new Map(prev).set(id, pos));
  }, []);
  const onStatus = useCallback((id: string, status: string) => {
    setStatuses(prev => prev.get(id) === status ? prev : new Map(prev).set(id, status));
  }, []);

  useEffect(() => {
    if (!map) return;
    if (!initialized.current && (activePosition || firstFix)) {
      const pos = (activePosition ?? firstFix)!;
      map.setView([pos.lat, pos.lon], zoom, { animate: false });
      initialized.current = true;
    }
    if (activePosition && (focusPending.current || (follow && !paused))) {
      map.panTo([activePosition.lat, activePosition.lon], { animate: false });
      focusPending.current = false;
    }
  }, [map, selected, activePosition, firstFix, follow, paused, zoom]);

  const chooseFeed = (id: string) => {
    setVisible(prev => new Set([...prev, id]));
    setSelected(id);
    setPaused(false);
    focusPending.current = true;
  };
  const showFeed = (id: string, show: boolean) => {
    const next = new Set(visible);
    if (show) next.add(id); else next.delete(id);
    setVisible(next);
    if (!next.has(selected)) {
      focusPending.current = false;
      setSelected(feeds.find(f => next.has(f.id))?.id ?? "");
      setPaused(false);
    }
  };
  const resume = () => {
    setPaused(false);
    if (map && activePosition) map.panTo([activePosition.lat, activePosition.lon], { animate: false });
  };

  return (
    <div className="widget-card widget-map">
      <div className="map-heading">
        <span className="widget-label">{label}</span>
        <label className="map-basemap">Basemap
          <select aria-label={`Basemap for ${label}`} value={basemap}
            onChange={e => setBasemap(e.target.value as BasemapId)}>
            {layers.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
      </div>
      {(widget.feeds || feeds.length > 1) && (
        <div className="map-feed-controls">
          <div className="map-feed-list" role="group" aria-label={`Visible feeds for ${label}`}>
            {feeds.map((feed, i) => (
              <label className="map-feed-toggle" key={feed.id} title={feed.topic}>
                <input type="checkbox" aria-label={`Show ${feed.label ?? feed.topic}`} checked={visible.has(feed.id)}
                  onChange={e => showFeed(feed.id, e.target.checked)} />
                <span className="map-feed-swatch" style={{ background: feed.color ?? FEED_COLORS[i % FEED_COLORS.length] }} />
                {feed.label ?? feed.topic}
              </label>
            ))}
          </div>
          <label className="map-feed-select">{follow ? "Follow" : "Focus"}
            <select aria-label={`Position feed for ${label}`} value={selected} onChange={e => chooseFeed(e.target.value)}>
              {!selected && <option value="" disabled>Choose feed</option>}
              {feeds.map(feed => <option key={feed.id} value={feed.id}>{feed.label ?? feed.topic}</option>)}
            </select>
          </label>
        </div>
      )}
      {firstFix && !activePosition && selected && (
        <span className="map-feed-status">{feeds.find(f => f.id === selected)?.label ?? selected}: {statuses.get(selected) ?? "waiting for fix…"}</span>
      )}
      <div className="map-frame">
        <div className="map-container" ref={containerRef} />
        {!firstFix && <div className="map-overlay"><span className="empty">
          {visible.size === 0 ? "All feeds hidden" : statuses.get(selected) ?? "waiting for fix…"}
        </span></div>}
        {activePosition && (paused || !follow) && (
          <button className="btn map-follow" title="re-center on the selected feed" onClick={resume}>
            ⌖ {follow ? "follow" : "center"}
          </button>
        )}
      </div>
      {map && feeds.map((feed, i) => (
        <MapFeedLayer key={feed.id} map={map} feed={feed} color={feed.color ?? FEED_COLORS[i % FEED_COLORS.length]}
          visible={visible.has(feed.id)} trailMax={trailMax} onPosition={onPosition} onStatus={onStatus} />
      ))}
    </div>
  );
}
