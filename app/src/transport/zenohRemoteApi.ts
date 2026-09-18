import {
  Config,
  ConsolidationMode,
  Duration,
  KeyExpr,
  QueryTarget,
  ReplyError,
  ReplyKeyExpr,
  SampleKind,
  Session,
  Sample as ZSample,
} from "@eclipse-zenoh/zenoh-ts";
import type { Reply } from "@eclipse-zenoh/zenoh-ts";
import type { GetReply, LivelinessEvent, Sample, Subscription, Transport, TransportGetOptions } from "./types";

const TARGET: Record<NonNullable<TransportGetOptions["target"]>, QueryTarget> = {
  "best-matching": QueryTarget.BEST_MATCHING,
  all: QueryTarget.ALL,
  "all-complete": QueryTarget.ALL_COMPLETE,
};

const CONSOLIDATION: Record<NonNullable<TransportGetOptions["consolidation"]>, ConsolidationMode> = {
  auto: ConsolidationMode.AUTO,
  none: ConsolidationMode.NONE,
  monotonic: ConsolidationMode.MONOTONIC,
  latest: ConsolidationMode.LATEST,
};

function mapSample(s: ZSample): Sample {
  return {
    keyexpr: s.keyexpr().toString(),
    payload: s.payload().toBytes(),
    kind: s.kind() === SampleKind.DELETE ? "delete" : "put",
    attachment: s.attachment()?.toBytes(),
  };
}

/** Transport backed by zenoh-ts over the remote-api WebSocket plugin. */
export class ZenohRemoteApiTransport implements Transport {
  private vehicleBridgeId?: string;
  private nextEndpoint = 1;
  // Remote clients can share one server session; allocate a distinct ROS node identity per client.
  private readonly nodeId = String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  private constructor(private readonly session: Session) {}

  static async open(locator: string, signal?: AbortSignal, openTimeoutMs = 8_000): Promise<ZenohRemoteApiTransport> {
    // Extra dial options are supplied by our version-checked SDK patch (app/patches/zenoh-ts.mjs).
    const config = Object.assign(new Config(locator, 3_000), { signal, openTimeoutMs });
    const session = await Session.open(config);
    if (signal?.aborted) { await session.close(); throw new Error("Connection cancelled"); }
    return new ZenohRemoteApiTransport(session);
  }

  async bridgeId(): Promise<string> { return (await this.session.info()).zid().toString(); }

  useVehicleProbe(id: string): void { this.vehicleBridgeId = id; }

  async verifyVehicle(id: string): Promise<void> {
    if (!/^[0-9a-f]{1,32}$/i.test(id)) throw new Error("Invalid vehicle bridge identity");
    // 1.9's admin handler answers version through the wildcard branch only. Match exactly this
    // bridge's version, never config/clients or arbitrary fleet data. The reply travels from the
    // VEHICLE plugin through native Zenoh; an empty localhost liveliness query cannot prove that.
    const key = `@/${id}/remote-plugin/version`;
    const replies = await this.get(`${key}$*`, { timeoutMs: 3_000, maxReplies: 1, maxReplyBytes: 4096 });
    if (!replies.some(r => r.keyexpr === key)) throw new Error("Local bridge cannot reach the selected vehicle");
  }

  async checkConnection(): Promise<void> {
    if (this.vehicleBridgeId) await this.verifyVehicle(this.vehicleBridgeId);
    else await this.liveliness.get("@dashboard/link-probe");
  }

  async subscribe(keyexpr: string, onSample: (s: Sample) => void): Promise<Subscription> {
    const sub = await this.session.declareSubscriber(new KeyExpr(keyexpr), {
      handler: (s: ZSample) => onSample(mapSample(s)),
    });
    return { close: () => sub.undeclare() };
  }

  async declareRosSubscriber(topic: Parameters<NonNullable<Transport["declareRosSubscriber"]>>[0]): Promise<Subscription> {
    const prefix = `@ros2_lv/${topic.domainId}/${(await this.session.info()).zid()}/${this.nodeId}/${this.nextEndpoint++}/MS/%/%/dashboard_3d`;
    const mangle = (s: string) => s.replaceAll("/", "%");
    const qos = `2:${topic.transientLocal ? "1" : "2"}:1,100:,:,:,,`;
    const token = await this.session.liveliness().declareToken(`${prefix}/${mangle(topic.name)}/${mangle(topic.typeDds)}/${mangle(topic.typeHash)}/${qos}${topic.bufferAware ? "/backends:cpu:" : ""}`);
    return { close: () => token.undeclare() };
  }

  async get(keyexpr: string, opts?: TransportGetOptions): Promise<GetReply[]> {
    const zopts: NonNullable<Parameters<Session["get"]>[1]> = {};
    if (opts?.payload) zopts.payload = opts.payload;
    if (opts?.attachment) zopts.attachment = opts.attachment;
    if (opts?.timeoutMs !== undefined) zopts.timeout = Duration.milliseconds.of(opts.timeoutMs);
    if (opts?.target !== undefined) zopts.target = TARGET[opts.target];
    if (opts?.consolidation !== undefined) zopts.consolidation = CONSOLIDATION[opts.consolidation];
    if (opts?.acceptReplies !== undefined) zopts.acceptReplies = opts.acceptReplies === "any" ? ReplyKeyExpr.ANY : ReplyKeyExpr.MATCHING_QUERY;
    const receiver = await this.session.get(keyexpr, Object.keys(zopts).length > 0 ? zopts : undefined);
    const out: GetReply[] = [];
    let bytes = 0;
    if (!receiver) return out;
    for await (const reply of receiver as AsyncIterable<Reply>) {
      const r = reply.result();
      if (r instanceof ZSample) {
        const payload = r.payload().toBytes(); bytes += payload.byteLength;
        if (bytes > (opts?.maxReplyBytes ?? Infinity) || out.length >= (opts?.maxReplies ?? Infinity)) throw new Error("query reply budget exceeded");
        out.push({
          keyexpr: r.keyexpr().toString(),
          payload,
          attachment: r.attachment()?.toBytes(),
        });
      } else if (r instanceof ReplyError) {
        opts?.onReplyError?.(new TextDecoder().decode(r.payload().toBytes()));
      }
    }
    return out;
  }

  readonly liveliness = {
    subscribe: async (keyexpr: string, onEvent: (e: LivelinessEvent) => void): Promise<Subscription> => {
      const sub = await this.session.liveliness().declareSubscriber(new KeyExpr(keyexpr), {
        handler: (s: ZSample) =>
          onEvent({ keyexpr: s.keyexpr().toString(), alive: s.kind() !== SampleKind.DELETE }),
        history: true,
      });
      return { close: () => sub.undeclare() };
    },
    get: async (keyexpr: string): Promise<string[]> => {
      const receiver = await this.session.liveliness().get(new KeyExpr(keyexpr));
      const keys: string[] = [];
      if (!receiver) return keys;
      for await (const reply of receiver as AsyncIterable<Reply>) {
        const r = reply.result();
        if (r instanceof ZSample) keys.push(r.keyexpr().toString());
      }
      return keys;
    },
  };

  async close(): Promise<void> {
    await this.session.close();
  }
}
