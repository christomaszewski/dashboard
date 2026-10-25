// A node's own ~/get_type_description service, called over the bus: the full description of a type
// the node uses (a message it publishes or subscribes, a service it serves), bootstrapped with the
// bundled GetTypeDescription schema. Shared by service calls (SrvCodecResolver) and topic decoding
// (the dynamic topic decoder) — both need types the bundle does not carry (vendor drivers).
import { MessageReader, MessageWriter } from "@foxglove/rosmsg2-serialization";
import type { MessageDefinition } from "@foxglove/message-definition";
import type { Transport } from "../transport/types";
import type { LivelinessEntity, RosGraph } from "../ros/graph";
import { findTypeDescriptionServer, serviceQueryKeyexpr } from "./keyexpr";
import { rawCall } from "./client";
import { GET_TYPE_DESCRIPTION_SRV } from "./srvDefs";
import type { TypeDescriptionMsg } from "./typeDescription";

export const GTD_TIMEOUT_MS = 5000;

export type DescribeResult = { ok: true; description: TypeDescriptionMsg } | { ok: false; reason: string };

interface GtdResponse {
  successful: boolean;
  failure_reason: string;
  type_description: TypeDescriptionMsg;
}

let gtdCodec: { writer: MessageWriter; reader: MessageReader } | null = null;
function codec() {
  gtdCodec ??= {
    writer: new MessageWriter(GET_TYPE_DESCRIPTION_SRV.requestDefs as MessageDefinition[]),
    reader: new MessageReader(GET_TYPE_DESCRIPTION_SRV.responseDefs as MessageDefinition[]),
  };
  return gtdCodec;
}

/** Ask `holder`'s node to describe `typeName` (exact `typeHash`). Never throws: the reason says why not. */
export async function describeType(
  transport: Transport,
  graph: RosGraph,
  holder: LivelinessEntity,
  typeName: string,
  typeHash: string,
  timeoutMs = GTD_TIMEOUT_MS,
): Promise<DescribeResult> {
  const server = findTypeDescriptionServer(graph, holder);
  if (!server) return { ok: false, reason: `node ${holder.nodeFq} does not expose ~/get_type_description` };
  const { writer, reader } = codec();
  const request = writer.writeMessage({ type_name: typeName, type_hash: typeHash, include_type_sources: false });
  let replies: { payload: Uint8Array }[];
  let replyErrors: string[];
  try {
    ({ replies, replyErrors } = await rawCall(transport, serviceQueryKeyexpr(server), request, timeoutMs));
  } catch (e) {
    return { ok: false, reason: `${holder.nodeFq}/get_type_description failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (replies.length === 0) {
    const detail = replyErrors.length > 0 ? `: ${replyErrors.join("; ")}` : "";
    return { ok: false, reason: `${holder.nodeFq}/get_type_description did not reply${detail}` };
  }
  let response: GtdResponse;
  try {
    response = reader.readMessage(replies[0].payload) as GtdResponse;
  } catch (e) {
    return { ok: false, reason: `GetTypeDescription response undecodable: ${String(e)}` };
  }
  if (!response.successful) {
    return { ok: false, reason: `${holder.nodeFq} could not describe '${typeName}': ${response.failure_reason || "no reason given"}` };
  }
  return { ok: true, description: response.type_description };
}
