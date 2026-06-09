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
}

export interface Transport {
  subscribe(keyexpr: string, onSample: (s: Sample) => void): Promise<Subscription>;
  /** Query (also used for service-style calls via the optional payload). Returns the sample replies. */
  get(keyexpr: string, opts?: { payload?: Uint8Array }): Promise<GetReply[]>;
  readonly liveliness: {
    subscribe(keyexpr: string, onEvent: (e: LivelinessEvent) => void): Promise<Subscription>;
    /** Current live keyexprs (cold-start snapshot). */
    get(keyexpr: string): Promise<string[]>;
  };
  close(): Promise<void>;
}
