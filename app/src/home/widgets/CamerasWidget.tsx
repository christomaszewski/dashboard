import { useState } from "react";
import type { CamerasWidgetConfig } from "../../config/schema";
import type { CamerasLayout } from "./specs";
import { StreamDeck } from "../../streams/StreamDeck";
import { StreamPicker } from "../../streams/StreamPicker";
import { useStreamsContext } from "../../streams/StreamsContext";
import { resolveStreamRef } from "../resolveStream";
import { loadChoice, saveChoice, widgetKey } from "./persist";

interface Memory {
  keys?: string[];
  focus?: string | null;
  layout?: CamerasLayout;
}
const isMemory = (v: unknown): v is Memory => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Several feeds in one Home widget, on the same deck the Cameras tab uses: `focus` = one large
 * feed with the rest as a carousel of live thumbnails (click one to bring it up, ←/→ cycle, Esc
 * to the grid), `grid` = all tiled. The set is `streams:` from the config or, when omitted, every
 * discovered stream; the picker adds feeds and a tile's ✕ removes one, unless `lock`. Layout,
 * focus and the set are remembered per widget. Every feed is a pooled WebRTC session and a
 * vehicle-side encode: shared with other tiles of the same stream, but not free.
 */
export function CamerasWidget({ widget }: { widget: CamerasWidgetConfig }) {
  const { streams } = useStreamsContext();
  const memory = widgetKey("cameras", widget.label, "default");
  const [mem, setMem] = useState<Memory>(() => (widget.lock ? {} : (loadChoice(memory, isMemory) ?? {})));
  const remember = (patch: Memory) => {
    const next = { ...mem, ...patch };
    setMem(next);
    if (!widget.lock) saveChoice(memory, next);
  };

  const configured = widget.streams
    ? widget.streams.map((ref) => resolveStreamRef(streams, ref)).filter((s): s is NonNullable<typeof s> => s !== undefined)
    : undefined;
  const chosen = mem.keys && !widget.lock
    ? mem.keys.map((k) => streams.find((s) => s.key === k)).filter((s): s is NonNullable<typeof s> => s !== undefined)
    : undefined;
  const shown = chosen ?? configured ?? streams;
  const layout = (!widget.lock && mem.layout) || widget.layout;
  const initialFocus = widget.focus ? resolveStreamRef(streams, widget.focus)?.key : undefined;
  const focusKey = (!widget.lock && mem.focus !== undefined ? mem.focus : null) ?? initialFocus ?? null;

  const keys = shown.map((s) => s.key);
  const add = (key: string) => remember({ keys: [...keys, key] });
  const remove = (key: string) => remember({ keys: keys.filter((k) => k !== key), focus: mem.focus === key ? null : mem.focus });
  const label = widget.label ?? "Cameras";

  return (
    <div className="widget-card widget-cameras">
      <div className="widget-head">
        <span className="widget-label">{label}</span>
        <span className="meta dim">
          {shown.length} of {streams.length} watching
        </span>
        <span className="spacer" />
        {shown.length > 1 && (
          <button
            className="btn small"
            title={layout === "focus" ? "tile every feed" : "one feed in focus, the rest as thumbnails"}
            onClick={() => remember({ layout: layout === "focus" ? "grid" : "focus" })}
          >
            {layout === "focus" ? "⊞ grid" : "▣ focus"}
          </button>
        )}
        {!widget.lock && keys.length < streams.length && (
          <StreamPicker streams={streams} value={null} exclude={keys} onChange={add} placeholder="add a feed…" title="add a feed" />
        )}
      </div>
      {shown.length === 0 ? (
        <p className="empty">
          {streams.length === 0 ? "waiting for streams to advertise…" : "no feeds selected — add one above"}
        </p>
      ) : (
        <StreamDeck
          streams={shown}
          layout={layout}
          focusKey={focusKey}
          onFocus={(key) => remember({ focus: key })}
          onLayout={(l) => remember({ layout: l })}
          onClose={widget.lock ? undefined : remove}
          columns={widget.columns}
          controls={widget.controls}
          confirm={widget.confirm}
          runId={widget.run_id}
        />
      )}
    </div>
  );
}
