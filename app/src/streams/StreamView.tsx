import { useEffect, useRef, useState } from "react";
import type { DiscoveredStream } from "./types";
import type { StreamSource } from "./source/types";
import { createSource } from "./source/registry";

type ViewState = "opening" | "playing" | "reconnecting" | "offline" | "error";
export type ViewMode = "grid" | "focused" | "thumb";

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 10_000;
// Stall watchdog: a dead session (ICE drop, producer restart) often fires NO gstwebrtc event — the
// video just freezes at "playing". If currentTime stops advancing this long, retry. Must sit above
// the source cameras' ride-through output gaps (~6 s on the ZR30) so a healthy-but-quiet session
// isn't churned.
const STALL_MS = 12_000;
const STALL_POLL_MS = 3_000;

/**
 * One SUBSCRIBED stream: mounting opens the session, unmounting closes it — the parent console owns
 * the subscription list. The session self-heals (backoff retries, stall watchdog, liveliness-flap
 * resume) for as long as the component lives. `mode` only changes the chrome/CSS — the <video> and
 * its session survive grid ↔ focus ↔ thumb switches untouched, so layout changes are instant.
 */
export function StreamView({
  stream,
  mode,
  onFocus,
  onRestore,
  onClose,
}: {
  stream: DiscoveredStream;
  mode: ViewMode;
  onFocus: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<StreamSource | null>(null);
  const latest = useRef(stream);
  latest.current = stream;

  const alive = useRef(true); // component lifetime guard (subscription = lifetime)
  const retryTimer = useRef<number | null>(null);
  const backoff = useRef(RETRY_BASE_MS);

  const [state, setState] = useState<ViewState>("opening");
  const [err, setErr] = useState("");

  const clearRetry = () => {
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  };

  const closeSource = () => {
    sourceRef.current?.close();
    sourceRef.current = null;
  };

  const scheduleRetry = (reason: string) => {
    if (!alive.current) return;
    closeSource();
    if (retryTimer.current !== null) return; // one pending retry at a time (error+closed both fire)
    if (!latest.current.alive) {
      setState("offline"); // no point dialing a withdrawn producer; alive→true resumes us
      return;
    }
    setState("reconnecting");
    setErr(reason);
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null;
      void attempt();
    }, backoff.current);
    backoff.current = Math.min(backoff.current * 2, RETRY_MAX_MS);
  };

  const attempt = async () => {
    const video = videoRef.current;
    if (!video || !alive.current) return;
    if (!latest.current.alive) {
      setState("offline");
      return;
    }
    closeSource();
    setState((s) => (s === "reconnecting" ? s : "opening"));
    setErr("");
    video.onplaying = () => {
      backoff.current = RETRY_BASE_MS; // healthy again → future retries start fast
      setState("playing");
    };
    try {
      const src = createSource(latest.current.descriptor);
      sourceRef.current = src;
      await src.open(video, {
        onError: (m) => scheduleRetry(m),
        onClosed: () => scheduleRetry("session closed"),
      });
    } catch (e) {
      scheduleRetry(String(e));
    }
  };

  // Subscription lifetime: open on mount, tear down on unmount.
  useEffect(() => {
    alive.current = true;
    void attempt();
    return () => {
      alive.current = false;
      clearRetry();
      closeSource();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stall watchdog (see STALL_MS): catches the session-death modes that emit no event at all.
  useEffect(() => {
    if (state !== "playing") return;
    let lastTime = -1;
    let lastAdvance = performance.now();
    const timer = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || !alive.current) return;
      if (v.currentTime !== lastTime) {
        lastTime = v.currentTime;
        lastAdvance = performance.now();
      } else if (performance.now() - lastAdvance > STALL_MS) {
        console.warn("[stream] video stalled — reconnecting", stream.key);
        scheduleRetry("video stalled");
      }
    }, STALL_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Liveliness transitions: producer came back → resume now; producer withdrew → drop the dead
  // session and wait (the signalling server likely went with it).
  useEffect(() => {
    if (stream.alive && state === "offline") {
      backoff.current = RETRY_BASE_MS;
      clearRetry();
      void attempt();
    } else if (!stream.alive && state !== "offline") {
      clearRetry();
      closeSource();
      setState("offline");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.alive]);

  const { descriptor } = stream;
  const label = descriptor.role || descriptor.id;
  const dims = descriptor.width && descriptor.height ? `${descriptor.width}×${descriptor.height}` : "";
  const statusText =
    state === "offline" ? "offline — will resume" : state === "reconnecting" ? "reconnecting…" : state === "error" ? err || "error" : state;
  const pillClass =
    state === "playing" ? "ok" : state === "reconnecting" || state === "opening" || state === "offline" ? "warn" : "err";

  return (
    <div
      className={`stream-view ${mode}${stream.alive ? "" : " is-offline"}`}
      onClick={mode === "thumb" ? onFocus : undefined}
      title={mode === "thumb" ? `${label} — click to focus` : state === "reconnecting" ? err : undefined}
    >
      <div className="tile-media">
        <video ref={videoRef} autoPlay playsInline muted />
        <div className="tile-overlay">
          <strong>{label}</strong>
          {mode !== "thumb" && (
            <span className="meta">
              {descriptor.codec ?? "?"} {dims}
            </span>
          )}
        </div>
        {mode !== "thumb" && (
          <div className="tile-actions">
            <button
              className="icon-btn"
              title={mode === "focused" ? "back to grid (Esc)" : "maximize"}
              onClick={mode === "focused" ? onRestore : onFocus}
            >
              {mode === "focused" ? "⤡" : "⤢"}
            </button>
            <button className="icon-btn" title="unsubscribe" onClick={onClose}>
              ✕
            </button>
          </div>
        )}
        {mode !== "thumb" && state !== "playing" && <span className={`pill ${pillClass} tile-status`}>{statusText}</span>}
      </div>
    </div>
  );
}
