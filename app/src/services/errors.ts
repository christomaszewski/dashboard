export type ServiceCallErrorKind =
  | "no-server" // no SS token for the name (in the requested domain)
  | "ambiguous-service" // >1 domain / conflicting types and no domainId to disambiguate
  | "type-unresolvable" // not bundled + no get_type_description path, or the node said successful=false
  | "unsupported-type" // wstring / long double / fixed string fields
  | "encode-failed"
  | "timeout" // elapsed ≈ timeout with zero replies, or the client-side deadline passed
  | "disconnected" // the link to the sidecar is down (refused at once) or went down mid-call
  | "no-reply" // query completed early with zero sample replies
  | "reply-error" // zenoh ReplyError received (its payload text in message)
  | "decode-failed";

/** What the failure says about the vehicle: the request never reached it, the service refused it,
 *  or nobody knows — it may have run (no reply in time, the link died mid-call, an unreadable
 *  reply). On a spotty link the last is common, and retrying a non-idempotent action repeats it. */
export type CallOutcome = "not-sent" | "refused" | "unknown";

const OUTCOME: Record<ServiceCallErrorKind, CallOutcome> = {
  "no-server": "not-sent",
  "ambiguous-service": "not-sent",
  "type-unresolvable": "not-sent",
  "unsupported-type": "not-sent",
  "encode-failed": "not-sent",
  timeout: "unknown",
  disconnected: "unknown",
  "no-reply": "unknown",
  "reply-error": "refused",
  "decode-failed": "unknown",
};

export class ServiceCallError extends Error {
  readonly outcome: CallOutcome;
  constructor(
    readonly kind: ServiceCallErrorKind,
    readonly serviceName: string,
    message: string,
    options?: { cause?: unknown; outcome?: CallOutcome },
  ) {
    super(message, options);
    this.name = "ServiceCallError";
    this.outcome = options?.outcome ?? OUTCOME[kind];
  }
}

/** One line for an operator. An unknown outcome says so first: check before retrying. */
export function describeCallError(e: unknown): { text: string; unknown: boolean } {
  if (!(e instanceof ServiceCallError)) return { text: String(e instanceof Error ? e.message : e), unknown: false };
  const detail = `${e.kind}: ${e.message}`;
  if (e.outcome === "unknown") return { text: `outcome unknown — it may have run; check before retrying (${detail})`, unknown: true };
  return { text: detail, unknown: false };
}
