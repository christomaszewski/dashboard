import type { StreamDescriptor } from "../types";

/** A protocol-specific player: attaches a remote stream's MediaStream to a <video>, and tears down. */
export interface StreamSource {
  open(video: HTMLVideoElement): Promise<void>;
  close(): void;
}

export type StreamSourceFactory = (descriptor: StreamDescriptor) => StreamSource;
