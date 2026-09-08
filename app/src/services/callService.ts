// Public API: call a ROS2 service over zenoh by name, resolving its type from the live graph
// (bundled schema or dynamic get_type_description). Reply channels are per-query in zenoh-ts, so no
// request/response correlation is needed — the reply attachment's sequence number is only checked
// softly for diagnostics.
import type { MessageDefinition } from "@foxglove/message-definition";
import type { Transport } from "../transport/types";
import type { RosGraph, ServiceEntry } from "../ros/graph";
import type { DecodedMessage } from "../schema/types";
import { decodeAttachment } from "./attachment";
import { rawCall } from "./client";
import { ServiceCallError } from "./errors";
import { pickServer, serviceQueryKeyexpr } from "./keyexpr";
import { SrvCodecResolver } from "./resolveSrv";

export { ServiceCallError, type ServiceCallErrorKind } from "./errors";

const DEFAULT_TIMEOUT_MS = 5000;

export interface CallServiceOptions {
  timeoutMs?: number;
  domainId?: number;
}

export interface ServiceCallResult {
  response: DecodedMessage;
  raw: Uint8Array;
  serverKeyexpr: string;
  rttMs: number;
  warning?: string;
}

// One resolver (type cache) per transport session.
const resolvers = new WeakMap<Transport, SrvCodecResolver>();
function resolverFor(transport: Transport): SrvCodecResolver {
  let r = resolvers.get(transport);
  if (!r) {
    r = new SrvCodecResolver(transport);
    resolvers.set(transport, r);
  }
  return r;
}

function findEntry(graph: RosGraph, serviceName: string, domainId?: number): ServiceEntry {
  const entries = graph.services.filter((s) => s.name === serviceName && s.servers.length > 0);
  if (entries.length === 0)
    throw new ServiceCallError("no-server", serviceName, `no server advertises ${serviceName}`);
  if (entries.length === 1) return entries[0];
  const scoped = entries.filter((e) => e.servers.some((s) => s.domainId === domainId));
  if (domainId !== undefined && scoped.length === 1) return scoped[0];
  throw new ServiceCallError(
    "ambiguous-service",
    serviceName,
    `${entries.length} distinct servers advertise ${serviceName} (different domain or type) — pass domainId`,
  );
}

export interface ServiceShape {
  typeName: string;
  typeHash: string;
  /** Root-first request definitions (see services/fields.ts for turning them into a form). */
  requestDefs: MessageDefinition[];
}

/** Resolve a service's type WITHOUT calling it — for request forms. Same resolution (and cache)
 *  as callService: bundled schema or the serving node's ~/get_type_description. */
export async function describeService(
  transport: Transport,
  graph: RosGraph,
  serviceName: string,
  opts?: CallServiceOptions,
): Promise<ServiceShape> {
  const entry = findEntry(graph, serviceName, opts?.domainId);
  const server = pickServer(entry, opts?.domainId);
  if (!server)
    throw new ServiceCallError("no-server", serviceName, `no server for ${serviceName} in domain ${opts?.domainId}`);
  const codec = await resolverFor(transport).resolve(graph, server);
  return { typeName: codec.typeName, typeHash: codec.typeHash, requestDefs: codec.requestDefs };
}

export async function callService(
  transport: Transport,
  graph: RosGraph,
  serviceName: string,
  request: Record<string, unknown>,
  opts?: CallServiceOptions,
): Promise<ServiceCallResult> {
  const entry = findEntry(graph, serviceName, opts?.domainId);
  const server = pickServer(entry, opts?.domainId);
  if (!server)
    throw new ServiceCallError("no-server", serviceName, `no server for ${serviceName} in domain ${opts?.domainId}`);

  const codec = await resolverFor(transport).resolve(graph, server);

  let payload: Uint8Array;
  try {
    payload = codec.encodeRequest(request);
  } catch (e) {
    throw new ServiceCallError("encode-failed", serviceName, `request encode failed: ${String(e)}`, { cause: e });
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const keyexpr = serviceQueryKeyexpr(server);
  const { replies, seq, elapsedMs, replyErrors } = await rawCall(transport, keyexpr, payload, timeoutMs);

  if (replies.length === 0) {
    if (replyErrors.length > 0)
      throw new ServiceCallError("reply-error", serviceName, replyErrors.join("; "));
    if (elapsedMs >= timeoutMs * 0.95)
      throw new ServiceCallError("timeout", serviceName, `no reply within ${timeoutMs} ms`);
    throw new ServiceCallError("no-reply", serviceName, "query completed with no reply");
  }

  const reply = replies[0];
  let response: DecodedMessage;
  try {
    response = codec.decodeResponse(reply.payload);
  } catch (e) {
    throw new ServiceCallError("decode-failed", serviceName, `response decode failed: ${String(e)}`, { cause: e });
  }

  let warning = codec.lastResponseWarning();
  if (reply.attachment) {
    try {
      const replyMeta = decodeAttachment(reply.attachment);
      if (replyMeta.sequenceNumber !== seq)
        warning = `reply sequence ${replyMeta.sequenceNumber} != request ${seq}${warning ? `; ${warning}` : ""}`;
    } catch {
      // absent/undecodable reply attachments are tolerated — correlation is per-query anyway
    }
  }

  return { response, raw: reply.payload, serverKeyexpr: keyexpr, rttMs: elapsedMs, warning };
}
