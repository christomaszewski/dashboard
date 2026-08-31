import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { MapWidgetConfig } from "../../config/schema";
import { useTopic } from "../../ros/useTopic";
import { extractLatLon } from "../geo";

// Tiles are ALWAYS fetched by the viewing browser, never the vehicle: the OSM default works on any
// internet-connected operator PC with zero vehicle involvement; fully-offline ops point `tiles:`
// at an operator-PC tile server (e.g. http://localhost:8000/{z}/{x}/{y}.png over a z/x/y tree) or
// a vehicle-mounted path. Unreachable tiles degrade to the plain background — marker + trail
// always work.
const OSM_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

/** Live vehicle position off the shared TopicStore: marker + breadcrumb trail, follow mode. */
export function MapWidget({ widget }: { widget: MapWidgetConfig }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const trailRef = useRef<L.Polyline | null>(null);
  const hasFixRef = useRef(false);
  const followPaused = useRef(false);
  const [hasFix, setHasFix] = useState(false);
  const [paused, setPaused] = useState(false);
  const { topic, snapshot } = useTopic(widget.topic);

  const zoom = Math.min(22, Math.max(2, widget.zoom ?? 17));
  const follow = widget.follow ?? true;
  const trailMax = Math.max(0, widget.trail ?? 500);
  const tiles = widget.tiles ?? OSM_TEMPLATE;

  // Map lifetime == widget mount (Home stays mounted across tab switches).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const map = L.map(el, { attributionControl: false, center: [0, 0], zoom });
    if (tiles !== "none") {
      const attribution = widget.attribution ?? (tiles === OSM_TEMPLATE ? OSM_ATTRIBUTION : undefined);
      if (attribution) L.control.attribution({ prefix: false }).addAttribution(attribution).addTo(map);
      L.tileLayer(tiles, { maxZoom: 22 }).addTo(map);
    }
    markerRef.current = L.marker([0, 0], {
      icon: L.divIcon({ className: "map-vehicle", iconSize: [14, 14] }),
      interactive: false,
    });
    trailRef.current = L.polyline([], { color: "var(--accent)", weight: 2, opacity: 0.7 }).addTo(map);
    // A user pan pauses follow mode; the ⌖ button resumes it.
    map.on("dragstart", () => {
      followPaused.current = true;
      setPaused(true);
    });
    // Leaflet mis-sizes inside display:none ancestors (hidden tabs) and on grid-area layout
    // changes — invalidate whenever the container actually has a size.
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0) map.invalidateSize();
    });
    observer.observe(el);
    mapRef.current = map;
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      trailRef.current = null;
    };
    // Config values are per-widget-instance constants; the map is built once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Position updates.
  const message = snapshot?.message;
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    const trail = trailRef.current;
    if (!map || !marker || !trail || message === undefined) return;
    const pos = extractLatLon(message, widget.lat_field ?? "latitude", widget.lon_field ?? "longitude");
    if (!pos) return;
    const ll = L.latLng(pos.lat, pos.lon);
    if (!hasFixRef.current) {
      hasFixRef.current = true;
      setHasFix(true);
      marker.addTo(map);
      map.setView(ll, zoom, { animate: false }); // first fix: jump straight there
    }
    marker.setLatLng(ll);
    if (trailMax > 0) {
      const pts = trail.getLatLngs() as L.LatLng[];
      pts.push(ll);
      if (pts.length > trailMax) pts.splice(0, pts.length - trailMax);
      trail.setLatLngs(pts);
    }
    if (follow && !followPaused.current) map.panTo(ll, { animate: false });
  }, [message, widget.lat_field, widget.lon_field, zoom, follow, trailMax]);

  const resume = () => {
    followPaused.current = false;
    setPaused(false);
    const marker = markerRef.current;
    if (marker && hasFixRef.current) mapRef.current?.panTo(marker.getLatLng(), { animate: false });
  };

  return (
    <div className="widget-card widget-map">
      <span className="widget-label">{widget.label ?? widget.topic}</span>
      <div className="map-frame">
        <div className="map-container" ref={containerRef} />
        {!hasFix && (
          <div className="map-overlay">
            <span className="empty">
              {snapshot?.error ? snapshot.error : topic ? "waiting for fix…" : `waiting for ${widget.topic}…`}
            </span>
          </div>
        )}
        {paused && follow && hasFix && (
          <button className="btn map-follow" title="re-center on the vehicle" onClick={resume}>
            ⌖ follow
          </button>
        )}
      </div>
    </div>
  );
}
