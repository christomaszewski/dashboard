import { useEffect, useRef, useState } from "react";
import type { DiscoveredStream } from "./types";
import type { StreamSource } from "./source/types";
import { createSource } from "./source/registry";

type TileState = "idle" | "opening" | "playing" | "reconnecting" | "offline" | "error";

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 10_000;
// Stall watchdog: a dead session (ICE drop, producer restart) often fires NO gstwebrtc event — the
// video just freezes at "playing". If currentTime stops advancing this long, retry. Must sit above
// the source cameras' ride-through output gaps (~6 s on the ZR30) so a healthy-but-quiet session
// isn't churned.
const STALL_MS = 12_000;
const STALL_POLL_MS = 3_000;

/**
 * One stream's viewer. Play records *intent*: while intent is on, the tile self-heals — an
 * unexpected session end (signalling socket drop, bridge restart, ICE failure) schedules a
 * backoff retry, and a liveliness flap (stream offline → back) resumes playback as soon as the
 * producer re-advertises. Stop clears the intent. Each (re)attempt re-resolves the producer from
 * the CURRENT descriptor — ports/peer-ids change across producer restarts.
 */
export function StreamTile({ stream }: { stream: DiscoveredStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<StreamSource | null>(null);
  const latest = useRef(stream);
  latest.current = stream;

  const desired = useRef(false); // operator wants this playing (survives flaps/retries)
  const retryTimer = useRef<number | null>(null);
  const backoff = useRef(RETRY_BASE_MS);

  const [state, setState] = useState<TileState>("idle");
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
    if (!desired.current) return;
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
    if (!video || !desired.current) return;
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

  const play = () => {
    desired.current = true;
    backoff.current = RETRY_BASE_MS;
    clearRetry();
    void attempt();
  };

  const stop = () => {
    desired.current = false;
    clearRetry();
    closeSource();
    if (videoRef.current) videoRef.current.srcObject = null;
    setState("idle");
    setErr("");
  };

  // Stall watchdog (see STALL_MS): catches the session-death modes that emit no event at all.
  useEffect(() => {
    if (state !== "playing") return;
    let lastTime = -1;
    let lastAdvance = performance.now();
    const timer = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || !desired.current) return;
      if (v.currentTime !== lastTime) {
        lastTime = v.currentTime;
        lastAdvance = performance.now();
      } else if (performance.now() - lastAdvance > STALL_MS) {
        console.warn("[tile] video stalled — reconnecting", stream.key);
        scheduleRetry("video stalled");
      }
    }, STALL_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Liveliness transitions: producer came back while we want to play → resume now; producer
  // withdrew → drop the dead session and wait (the signalling server likely went with it).
  useEffect(() => {
    if (!desired.current) return;
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

  useEffect(
    () => () => {
      clearRetry();
      closeSource();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { descriptor } = stream;
  const label = descriptor.role || descriptor.id;
  const dims = descriptor.width && descriptor.height ? ` ${descriptor.width}×${descriptor.height}` : "";
  const active = desired.current && state !== "idle" && state !== "error";
  const statusText =
    state === "offline"
      ? "offline — will resume"
      : state === "reconnecting"
        ? "reconnecting…"
        : state === "error"
          ? err || "error"
          : state;
  const pillClass =
    state === "playing"
      ? "ok"
      : state === "reconnecting" || state === "opening" || state === "offline"
        ? "warn"
        : state === "error"
          ? "err"
          : "idle";

  return (
    <div className={`tile${stream.alive ? "" : " offline"}`} title={state === "reconnecting" ? err : undefined}>
      <div className="tile-media">
        <video ref={videoRef} autoPlay playsInline muted />
        <div className="tile-overlay">
          <strong>{label}</strong>
          <span className="meta">
            {stream.vehicleId} · {descriptor.codec ?? "?"}
            {dims}
          </span>
        </div>
      </div>
      <div className="tile-controls">
        <button className={`btn${active ? "" : " primary"}`} onClick={active ? stop : play}>
          {active ? "Stop" : "Play"}
        </button>
        <span className={`pill ${pillClass}`}>{statusText}</span>
      </div>
    </div>
  );
}
