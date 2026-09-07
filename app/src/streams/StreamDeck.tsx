import { useEffect } from "react";
import type { CameraControls } from "../home/widgets/specs";
import { StreamView } from "./StreamView";
import type { DiscoveredStream } from "./types";

export type DeckLayout = "focus" | "grid";

/**
 * Several feeds, arranged: `grid` tiles them all; `focus` fills the area with one and runs the rest
 * as live thumbnails (the carousel) — click one to bring it up, ←/→ cycle, Esc hands back to the
 * grid (`onLayout`). Layout switches are pure CSS: the <video> elements and their pooled WebRTC
 * sessions are never unmounted, so swapping views never renegotiates. The Cameras tab's console
 * and the `cameras` Home widget are both this deck with their own stream set around it.
 */
export function StreamDeck({
  streams,
  layout,
  focusKey,
  onFocus,
  onLayout,
  onClose,
  columns,
  controls = "auto",
  confirm,
  runId,
}: {
  streams: DiscoveredStream[];
  layout: DeckLayout;
  /** The feed in focus (focus layout); null = the first stream. */
  focusKey: string | null;
  onFocus: (key: string) => void;
  /** Called with the layout the user asked for (⤡ / Esc → grid, ⤢ on a grid tile → focus). */
  onLayout?: (layout: DeckLayout) => void;
  /** Present = tiles carry a ✕ (unsubscribe). */
  onClose?: (key: string) => void;
  columns?: number;
  controls?: CameraControls;
  confirm?: boolean;
  runId?: string;
}) {
  const focused = layout === "focus" ? (streams.find((s) => s.key === focusKey)?.key ?? streams[0]?.key ?? null) : null;

  // Keyboard: Esc leaves focus, ←/→ cycle the focused feed.
  useEffect(() => {
    if (focused === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onLayout?.("grid");
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const keys = streams.map((s) => s.key);
        const i = keys.indexOf(focused);
        if (i === -1 || keys.length < 2) return;
        onFocus(keys[(i + (e.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length]);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, streams, onFocus, onLayout]);

  const style = layout === "grid" && columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined;
  return (
    <div className={focused !== null ? "console-focus" : "console-grid"} style={style} data-layout={layout}>
      {streams.map((s) => (
        <StreamView
          key={s.key}
          stream={s}
          mode={focused === null ? "grid" : s.key === focused ? "focused" : "thumb"}
          onFocus={() => {
            onFocus(s.key);
            if (layout !== "focus") onLayout?.("focus");
          }}
          onRestore={() => onLayout?.("grid")}
          onClose={onClose ? () => onClose(s.key) : undefined}
          controls={controls}
          confirm={confirm}
          runId={runId}
        />
      ))}
    </div>
  );
}
