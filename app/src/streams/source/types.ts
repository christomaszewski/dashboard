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
  /**
   * Optional transport diagnostics for the pool's retry log — a snapshot of the receive path, taken
   * the moment a session is given up on (stall watchdog / error / closed), so the reason is knowable
   * from the console instead of guessed: no packets (ICE/transport), packets but no decodable frames
   * (a lost keyframe waiting on the next IDR), or frames but freezes (encoder starvation upstream).
   * Resolves null when there is nothing to report (not connected yet, protocol without stats).
   */
  stats?(): Promise<StreamStats | null>;
}

/** Receive-path snapshot (a curated subset of WebRTC `inbound-rtp` + the selected `candidate-pair`). */
export interface StreamStats {
  packetsReceived?: number;
  packetsLost?: number;
  nackCount?: number;
  pliCount?: number;
  framesReceived?: number;
  framesDecoded?: number;
  framesDropped?: number;
  freezeCount?: number;
  totalFreezesDuration?: number; // seconds
  jitterBufferDelay?: number; // seconds, cumulative (÷ jitterBufferEmittedCount for the mean)
  jitterBufferEmittedCount?: number;
  /** Selected ICE pair: "udp host->host", "tcp host->srflx", ... — whether media rides UDP or TCP. */
  transport?: string;
  currentRoundTripTime?: number; // seconds
}

export type StreamSourceFactory = (descriptor: StreamDescriptor) => StreamSource;
