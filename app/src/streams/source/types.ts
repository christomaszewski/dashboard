import type { StreamDescriptor } from "../types";

/**
 * A protocol-specific player: negotiates the remote session and hands the MediaStream to the caller.
 * Sources never touch video elements — the session pool owns element attachment, so one session can
 * feed any number of <video>s (Home widget + Cameras tab, grid + thumb, …).
 */
export interface StreamSourceHooks {
  onStream: (stream: MediaStream) => void; // media negotiated, track(s) delivered
  onError?: (message: string) => void; // async failure after open() resolves (ICE, codec, signalling drop)
  onClosed?: () => void; // the remote session ended
}

export interface StreamSource {
  open(hooks: StreamSourceHooks): Promise<void>;
  close(): void;
}

export type StreamSourceFactory = (descriptor: StreamDescriptor) => StreamSource;
