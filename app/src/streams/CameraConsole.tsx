import { useEffect, useState } from "react";
import { StreamDeck } from "./StreamDeck";
import { useStreamsContext } from "./StreamsContext";

const STORE_KEY = "dashboard.cameras.subscribed";

function loadSubscribed(): string[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Operator camera console. Discovery populates an "available" rail; nothing plays until the
 * operator subscribes. Subscribed feeds render in one of two layouts:
 *   grid  — all feeds tiled
 *   focus — one feed fills the camera area, the rest run as live thumbnails (the "tabs"): click a
 *           thumbnail to swap focus instantly, ⤡/Esc to return to the grid, ←/→ to cycle.
 * Layout switches are pure CSS — the <video> elements (and their WebRTC sessions) are never
 * unmounted, so swapping views never renegotiates. Subscriptions persist across reloads.
 */
export function CameraConsole() {
  const { streams } = useStreamsContext();
  const [subscribed, setSubscribed] = useState<string[]>(loadSubscribed);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(subscribed));
    } catch {
      /* storage may be unavailable (private mode) — subscriptions just won't persist */
    }
  }, [subscribed]);

  const subStreams = subscribed
    .map((k) => streams.find((s) => s.key === k))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const focused = focusKey !== null && subStreams.some((s) => s.key === focusKey) ? focusKey : null;

  const toggle = (key: string) => {
    setSubscribed((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    if (focusKey === key) setFocusKey(null);
  };

  const watching = subStreams.length;
  return (
    <section className="card">
      <div className="card-header">
        <h2>Cameras</h2>
        <span className="meta">
          {streams.length} available{watching > 0 ? ` · ${watching} watching` : ""}
        </span>
        <span className="spacer" />
        {focused !== null && (
          <button className="btn" onClick={() => setFocusKey(null)}>
            ⊞ Grid view
          </button>
        )}
      </div>

      {streams.length === 0 ? (
        <p className="empty">
          No live streams advertised on <span className="mono">fleet/*/media/*</span>.
        </p>
      ) : (
        <div className="rail">
          {streams.map((s) => {
            const on = subscribed.includes(s.key);
            const label = s.descriptor.role || s.descriptor.id;
            const dims = s.descriptor.width && s.descriptor.height ? `${s.descriptor.width}×${s.descriptor.height}` : "";
            return (
              <button
                key={s.key}
                className={`rail-item${on ? " watching" : ""}${s.alive ? "" : " is-offline"}`}
                onClick={() => toggle(s.key)}
                title={on ? "click to unsubscribe" : "click to watch"}
              >
                <span className={`dot ${s.alive ? "ok" : ""}`} />
                {label}
                <span className="meta">
                  {s.descriptor.codec ?? "?"} {dims}
                </span>
                <span className="state">{on ? "✓" : "+"}</span>
              </button>
            );
          })}
        </div>
      )}

      {streams.length > 0 && watching === 0 && <p className="empty">Select a camera above to start watching.</p>}

      {watching > 0 && (
        <StreamDeck
          streams={subStreams}
          layout={focused !== null ? "focus" : "grid"}
          focusKey={focused}
          onFocus={setFocusKey}
          onLayout={(l) => {
            if (l === "grid") setFocusKey(null);
          }}
          onClose={toggle}
        />
      )}
    </section>
  );
}
