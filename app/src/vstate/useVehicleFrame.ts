import { useEffect, useState } from "react";
import { FrameFetcher, type FrameOptions } from "./frameClient";
import type { FrameHeader } from "./frames";
import { useVehicleState } from "./VehicleStateContext";

export interface VehicleFrame {
  /** Object URL of the newest frame; revoked when replaced or unmounted. */
  url?: string;
  header?: FrameHeader;
  /** Date.now() when the newest frame arrived. */
  receivedAt?: number;
  bytes?: number;
  linkMs?: number;
  level: number;
  error?: string;
  /** Set while the link is down (the last frame stays up). */
  link?: string;
  /** Vehicle frames are configured but this page cannot reach them yet. */
  unavailable?: string;
}

/** The latest vehicle frame of `topic`, fetched only while `active`. */
export function useVehicleFrame(topic: string | undefined, options: FrameOptions, active: boolean): VehicleFrame {
  const { frames, error: setupError } = useVehicleState();
  const [state, setState] = useState<VehicleFrame>({ level: 0 });
  const { maxHz, maxWidth, quality, format, normalize, adaptive } = options;

  useEffect(() => {
    if (!frames || !topic || !active) return;
    let url: string | undefined;
    const fetcher = new FrameFetcher({
      transport: frames.transport,
      base: frames.base,
      topic,
      options: { maxHz, maxWidth, quality, format, normalize, adaptive },
      onUpdate: (u) => {
        let next: string | undefined;
        if (u.image && u.header?.mime) {
          next = URL.createObjectURL(new Blob([u.image as BlobPart], { type: u.header.mime }));
          if (url) URL.revokeObjectURL(url);
          url = next;
        }
        setState((old) => ({
          url: next ?? old.url,
          header: u.header ?? old.header,
          receivedAt: next ? Date.now() : old.receivedAt,
          bytes: u.image ? u.image.length : old.bytes,
          linkMs: u.linkMs ?? old.linkMs,
          level: u.level,
          error: u.link ? old.error : u.error,
          link: u.link,
        }));
      },
    });
    fetcher.start();
    return () => {
      fetcher.stop();
      if (url) URL.revokeObjectURL(url);
      setState({ level: 0 });
    };
  }, [frames, topic, active, maxHz, maxWidth, quality, format, normalize, adaptive]);

  return frames ? state : { ...state, unavailable: setupError ?? "vehicle state is starting…" };
}
