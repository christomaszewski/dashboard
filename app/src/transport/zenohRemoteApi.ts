import {
  Config,
  ConsolidationMode,
  Duration,
  KeyExpr,
  QueryTarget,
  ReplyError,
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
  private constructor(private readonly session: Session) {}

  static async open(locator: string): Promise<ZenohRemoteApiTransport> {
    return new ZenohRemoteApiTransport(await Session.open(new Config(locator)));
  }

  async subscribe(keyexpr: string, onSample: (s: Sample) => void): Promise<Subscription> {
    const sub = await this.session.declareSubscriber(new KeyExpr(keyexpr), {
      handler: (s: ZSample) => onSample(mapSample(s)),
    });
    return { close: () => sub.undeclare() };
  }

  async get(keyexpr: string, opts?: TransportGetOptions): Promise<GetReply[]> {
    const zopts: NonNullable<Parameters<Session["get"]>[1]> = {};
    if (opts?.payload) zopts.payload = opts.payload;
    if (opts?.attachment) zopts.attachment = opts.attachment;
    if (opts?.timeoutMs !== undefined) zopts.timeout = Duration.milliseconds.of(opts.timeoutMs);
    if (opts?.target !== undefined) zopts.target = TARGET[opts.target];
    if (opts?.consolidation !== undefined) zopts.consolidation = CONSOLIDATION[opts.consolidation];
    const receiver = await this.session.get(keyexpr, Object.keys(zopts).length > 0 ? zopts : undefined);
    const out: GetReply[] = [];
    if (!receiver) return out;
    for await (const reply of receiver as AsyncIterable<Reply>) {
      const r = reply.result();
      if (r instanceof ZSample) {
        out.push({
          keyexpr: r.keyexpr().toString(),
          payload: r.payload().toBytes(),
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
