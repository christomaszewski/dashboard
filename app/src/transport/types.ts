// The transport abstraction the whole UI codes against — never zenoh-ts directly.
// Phase 1 impl: ZenohRemoteApiTransport (browser zenoh-ts ↔ the vehicle's remote-api sidecar).
// Later: a federated/laptop transport, or a Tauri-IPC transport — same interface, swap the impl.

export type SampleKind = "put" | "delete";

export interface Sample {
  keyexpr: string;
  payload: Uint8Array;
  kind: SampleKind;
  attachment?: Uint8Array;
}

export interface Subscription {
  close(): Promise<void>;
}

export interface LivelinessEvent {
  keyexpr: string;
  alive: boolean; // PUT → token appeared; DELETE → token dropped
}

export interface GetReply {
  keyexpr: string;
  payload: Uint8Array;
  attachment?: Uint8Array;
}

export interface TransportGetOptions {
  payload?: Uint8Array;
  /** Raw attachment bytes (rmw_zenoh service calls put the client attachment here). */
  attachment?: Uint8Array;
  /** Query timeout; default is the zenoh-ts default (10 s). */
  timeoutMs?: number;
  target?: "best-matching" | "all" | "all-complete";
  consolidation?: "auto" | "none" | "monotonic" | "latest";
  /** Zenoh-level error replies (ReplyError), payload decoded as UTF-8. Default: dropped. */
  onReplyError?: (message: string) => void;
}

export interface Transport {
  subscribe(keyexpr: string, onSample: (s: Sample) => void): Promise<Subscription>;
  /** Query (also used for ROS2 service calls: payload = CDR request, attachment = rmw client meta). */
  get(keyexpr: string, opts?: TransportGetOptions): Promise<GetReply[]>;
  readonly liveliness: {
    subscribe(keyexpr: string, onEvent: (e: LivelinessEvent) => void): Promise<Subscription>;
    /** Current live keyexprs (cold-start snapshot). */
    get(keyexpr: string): Promise<string[]>;
  };
  close(): Promise<void>;
}
