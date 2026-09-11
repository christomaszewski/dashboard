import { useEffect, useState } from "react";
import L from "leaflet";
import { useTopic } from "../../ros/useTopic";
import { extractHeading, extractLatLon, type MapPosition } from "../geo";
import type { MapFeedConfig } from "../mapConfig";

interface Props {
  map: L.Map;
  feed: MapFeedConfig;
  color: string;
  visible: boolean;
  trailMax: number;
  onPosition: (id: string, position: MapPosition) => void;
  onStatus: (id: string, status: string) => void;
}

/** One mounted subscriber per feed keeps hook order stable as layers are shown/hidden.
 * Hidden feeds continue tracking so showing one restores its current position and full trail.
 */
export function MapFeedLayer({ map, feed, color, visible, trailMax, onPosition, onStatus }: Props) {
  const position = useTopic(feed.topic);
  const orientation = useTopic(feed.orientation_topic);
  const label = feed.label ?? feed.topic;
  const [layer, setLayer] = useState<{
    group: L.LayerGroup; marker: L.Marker; trail: L.Polyline; symbol: HTMLElement; arrow: HTMLElement;
  } | null>(null);

  useEffect(() => {
    const symbol = document.createElement("span");
    symbol.className = "map-vehicle-symbol";
    symbol.style.color = color;
    symbol.setAttribute("role", "img");
    const dot = document.createElement("span");
    dot.className = "map-vehicle-dot";
    const arrow = document.createElement("span");
    arrow.className = "map-vehicle-arrow";
    symbol.append(dot, arrow);
    const marker = L.marker([0, 0], {
      icon: L.divIcon({ className: "map-vehicle", html: symbol, iconSize: [28, 28], iconAnchor: [14, 14] }),
      keyboard: false, title: label,
    });
    const tooltip = document.createElement("span");
    tooltip.textContent = label; // Config labels are text, never Leaflet HTML.
    marker.bindTooltip(tooltip, { direction: "top", offset: [0, -12] });
    const trail = L.polyline([], { color, weight: 2, opacity: 0.7 });
    const group = L.layerGroup([trail]);
    setLayer({ group, marker, trail, symbol, arrow });
    return () => { group.remove(); };
  }, [map, feed.id, feed.topic, color, label]);

  useEffect(() => {
    if (!layer || !visible) return;
    layer.group.addTo(map);
    return () => { layer.group.remove(); };
  }, [map, layer, visible]);

  const message = position.snapshot?.message;
  useEffect(() => {
    if (!layer || message === undefined) return;
    const pos = extractLatLon(message, feed.lat_field ?? "latitude", feed.lon_field ?? "longitude");
    if (!pos) return;
    const ll = L.latLng(pos.lat, pos.lon);
    layer.marker.setLatLng(ll);
    if (!layer.group.hasLayer(layer.marker)) layer.group.addLayer(layer.marker);
    if (trailMax > 0) {
      const points = layer.trail.getLatLngs() as L.LatLng[];
      points.push(ll);
      if (points.length > trailMax) points.splice(0, points.length - trailMax);
      layer.trail.setLatLngs(points);
    }
    onPosition(feed.id, pos);
  }, [layer, message, feed.id, feed.lat_field, feed.lon_field, trailMax, onPosition]);

  // IMU updates only rotate the inner symbol; Leaflet owns the outer marker's map transform.
  // They never append trail points or move the map.
  const heading = feed.orientation_topic && !orientation.snapshot?.error
    ? extractHeading(orientation.snapshot?.message, feed) : null;
  useEffect(() => {
    if (!layer) return;
    layer.symbol.classList.toggle("has-heading", heading !== null);
    layer.arrow.style.transform = heading === null ? "" : `rotate(${heading}deg)`;
    layer.symbol.setAttribute("aria-label", heading === null ? label : `${label}, heading ${Math.round(heading) % 360}°`);
  }, [layer, heading, label]);

  const status = position.snapshot?.error ?? (position.topic ? "waiting for fix…" : `waiting for ${feed.topic}…`);
  useEffect(() => { onStatus(feed.id, status); }, [feed.id, status, onStatus]);
  return null;
}
