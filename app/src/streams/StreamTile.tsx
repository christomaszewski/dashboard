import { useEffect, useRef, useState } from "react";
import type { DiscoveredStream } from "./types";
import type { StreamSource } from "./source/types";
import { createSource } from "./source/registry";

type TileState = "idle" | "opening" | "playing" | "error";

export function StreamTile({ stream }: { stream: DiscoveredStream }) {
  const { descriptor } = stream;
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<StreamSource | null>(null);
  const [state, setState] = useState<TileState>("idle");
  const [err, setErr] = useState("");

  useEffect(
    () => () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    },
    [],
  );

  const play = async () => {
    const video = videoRef.current;
    if (!video) return;
    setState("opening");
    setErr("");
    video.onplaying = () => setState("playing");
    try {
      const src = createSource(descriptor);
      sourceRef.current = src;
      await src.open(video, {
        onError: (m) => {
          setState("error");
          setErr(m);
        },
        onClosed: () => setState("idle"),
      });
    } catch (e) {
      sourceRef.current?.close();
      sourceRef.current = null;
      setState("error");
      setErr(String(e));
    }
  };

  const stop = () => {
    sourceRef.current?.close();
    sourceRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState("idle");
  };

  const label = descriptor.role || descriptor.id;
  const dims = descriptor.width && descriptor.height ? ` ${descriptor.width}×${descriptor.height}` : "";
  const active = state === "playing" || state === "opening";

  return (
    <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: ".5rem", width: 340 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: ".5rem" }}>
        <strong>{label}</strong>
        <small style={{ color: "#888" }}>
          {stream.vehicleId} · {descriptor.codec ?? "?"}
          {dims}
        </small>
      </div>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ width: "100%", height: 200, background: "#111", borderRadius: 6, marginBlock: ".4rem" }}
      />
      <div style={{ display: "flex", gap: ".5rem", alignItems: "center" }}>
        <button onClick={active ? stop : () => void play()}>{active ? "Stop" : "Play"}</button>
        <small style={{ color: state === "error" ? "#c33" : "#888" }}>{state === "error" ? err : state}</small>
      </div>
    </div>
  );
}
