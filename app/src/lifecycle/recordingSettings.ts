import type { Transport } from "../transport/types";
import { LifecycleError, parseChangeStateReply } from "./changeState";
import type { RecordingSettingsValues, RecordingSettingsVersion } from "./types";

export async function configureRecording(transport: Transport, key: string,
  settings: Partial<RecordingSettingsValues>, expected: RecordingSettingsVersion) {
  const timeoutMs = 20_000;
  const started = performance.now();
  const errors: string[] = [];
  const replies = await transport.get(`${key}/configure_recording`, {
    payload: new TextEncoder().encode(JSON.stringify({ settings,
      expected: { generation: expected.generation, revision: expected.revision } })),
    timeoutMs, onReplyError: message => errors.push(message),
  });
  if (!replies.length) {
    const kind = errors.length ? "bad-reply" : performance.now() - started >= timeoutMs * .95 ? "timeout" : "no-reply";
    throw new LifecycleError(kind, key, errors.join("; ") || "No reply; refresh settings before retrying.");
  }
  const result = parseChangeStateReply(replies[0].payload);
  if (!result || (result.ok && !result.descriptor?.recording_settings))
    throw new LifecycleError("bad-reply", key, "Reply has no valid recording settings.");
  return result;
}
