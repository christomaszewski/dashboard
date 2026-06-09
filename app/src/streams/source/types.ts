import type { StreamDescriptor } from "../types";

/** A protocol-specific player: attaches a remote stream's MediaStream to a <video>, and tears down. */
export interface StreamSourceHooks {
  onError?: (message: string) => void; // async failure after open() resolves (ICE, codec, signalling drop)
  onClosed?: () => void; // the remote session ended
}

export interface StreamSource {
  open(video: HTMLVideoElement, hooks?: StreamSourceHooks): Promise<void>;
  close(): void;
}

export type StreamSourceFactory = (descriptor: StreamDescriptor) => StreamSource;
