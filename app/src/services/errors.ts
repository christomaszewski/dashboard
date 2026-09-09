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

export class ServiceCallError extends Error {
  constructor(
    readonly kind: ServiceCallErrorKind,
    readonly serviceName: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ServiceCallError";
  }
}
