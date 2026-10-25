// Service type → request encoder + response decoder. Static bundle first (srvDefs); anything else
// resolves DYNAMICALLY over the bus: call the serving node's own ~/get_type_description service
// (bootstrapped with the statically-bundled GetTypeDescription schema) and compile the returned
// description. Cached by RIHS hash — a type is fetched + compiled at most once per session; failed
// resolutions are evicted so a transient failure doesn't poison the cache (FlavorResolver pattern).
import { MessageReader, MessageWriter } from "@foxglove/rosmsg2-serialization";
import type { MessageDefinition } from "@foxglove/message-definition";
import type { Transport } from "../transport/types";
import type { LivelinessEntity, RosGraph } from "../ros/graph";
import { ddsToRosName } from "../schema/typeName";
import type { DecodedMessage } from "../schema/types";
import { ServiceCallError } from "./errors";
import { describeType } from "./describeType";
import { STATIC_SRVS, type StaticSrvDef } from "./srvDefs";
import { srvCodecDefs } from "./typeDescription";

export interface SrvCodec {
  typeName: string;
  typeHash: string;
  /** Root-first request definitions — what encodeRequest writes; request forms are built from them. */
  requestDefs: MessageDefinition[];
  encodeRequest(msg: Record<string, unknown>): Uint8Array;
  decodeResponse(bytes: Uint8Array): DecodedMessage;
  /** Trailing-bytes diagnostic for the most recent decodeResponse. */
  lastResponseWarning(): string | undefined;
}

function buildCodec(typeName: string, typeHash: string, defs: StaticSrvDef): SrvCodec {
  const writer = new MessageWriter(defs.requestDefs as MessageDefinition[]);
  const reader = new MessageReader(defs.responseDefs as MessageDefinition[]);
  return {
    typeName,
    typeHash,
    requestDefs: defs.requestDefs as MessageDefinition[],
    encodeRequest: (msg) => writer.writeMessage(msg), // omitted fields zero-fill
    decodeResponse: (bytes) => reader.readMessage(bytes) as DecodedMessage,
    lastResponseWarning: () =>
      reader.lastReadHadTrailingBytes()
        ? `response decode of ${typeName} left trailing bytes — resolved definition may lag the server`
        : undefined,
  };
}

export class SrvCodecResolver {
  private readonly cache = new Map<string, Promise<SrvCodec>>();

  constructor(private readonly transport: Transport) {}

  /** `server`: the SS entity of the service being called (its token carries type + hash + node). */
  resolve(graph: RosGraph, server: LivelinessEntity): Promise<SrvCodec> {
    const hash = server.topic?.typeHash ?? "";
    let pending = this.cache.get(hash);
    if (!pending) {
      pending = this.build(graph, server);
      pending.catch(() => this.cache.delete(hash));
      this.cache.set(hash, pending);
    }
    return pending;
  }

  private async build(graph: RosGraph, server: LivelinessEntity): Promise<SrvCodec> {
    const t = server.topic;
    if (!t) throw new ServiceCallError("type-unresolvable", server.nodeFq, "SS token carries no type info");
    const typeName = ddsToRosName(t.typeDds) ?? t.typeDds;

    const bundled = STATIC_SRVS[typeName];
    if (bundled) return buildCodec(typeName, t.typeHash, bundled);

    // Dynamic path: ask the SERVING node — it definitionally knows the type it serves.
    const described = await describeType(this.transport, graph, server, typeName, t.typeHash);
    if (!described.ok) {
      const reason = described.reason.endsWith("does not expose ~/get_type_description")
        ? `'${typeName}' is not bundled and ${described.reason}`
        : described.reason;
      throw new ServiceCallError("type-unresolvable", t.name, reason);
    }
    return buildCodec(typeName, t.typeHash, srvCodecDefs(described.description));
  }
}
