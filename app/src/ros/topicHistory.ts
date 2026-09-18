import type { TopicEntry } from "./graph";
import type { GetReply, Transport } from "../transport/types";

/** Query every publisher, including Lyrical's hermetic AdvancedPublisher cache. */
export async function topicHistory(transport: Transport, topic: TopicEntry, maxReplyBytes = 8 * 1024 * 1024): Promise<GetReply[]> {
  const base = topic.dataKeyexpr.replace(/\/\*\*$/, "");
  const batches = await Promise.all([topic.dataKeyexpr, `${base}/@adv/**`].map((key) => transport.get(key,
    { target: "all", consolidation: "none", acceptReplies: "any", timeoutMs: 3000, maxReplyBytes, maxReplies: 4096 })));
  // Replies from an advanced cache have the original data key, outside the query key.
  return batches.flat().filter((r) => r.keyexpr === base || r.keyexpr === `${base}/_buf_cpu`);
}
