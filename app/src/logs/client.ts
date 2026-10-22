import type { Transport } from "../transport/types";

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  project: string;
  service: string;
}

export interface DockerLogSnapshot {
  container_id: string;
  tail: number;
  text: string;
  truncated: boolean;
  at_unix_s: number;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const containerId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

async function query(transport: Transport, key: string, payload?: object): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  const replies = await transport.get(key, {
    payload: payload ? new TextEncoder().encode(JSON.stringify(payload)) : undefined,
    timeoutMs: 5_000,
    maxReplies: 1,
    maxReplyBytes: 1024 * 1024,
    onReplyError: (error) => errors.push(error),
  });
  if (!replies.length) throw new Error(errors.join("; ") || "No reply from the vehicle's Docker log reader; retrying…");
  let doc: unknown;
  try { doc = JSON.parse(new TextDecoder().decode(replies[0].payload)); }
  catch { throw new Error("Invalid Docker log reader reply"); }
  if (!record(doc)) throw new Error("Invalid Docker log reader reply");
  if (doc.ok === false) throw new Error(typeof doc.error === "string" ? doc.error : "Docker request failed");
  if (doc.ok !== true || doc.schema_version !== 1) throw new Error("Unsupported Docker log reader reply");
  return doc;
}

export async function listContainers(transport: Transport, agentKey: string): Promise<DockerContainer[]> {
  const doc = await query(transport, `${agentKey}/docker/containers`);
  if (!Array.isArray(doc.containers) || !doc.containers.every((c) => record(c) && containerId(c.id) &&
    ["name", "image", "state", "status", "project", "service"].every((k) => typeof c[k] === "string"))) {
    throw new Error("Invalid Docker container inventory");
  }
  return doc.containers as DockerContainer[];
}

export async function readLogs(transport: Transport, agentKey: string, id: string, tail: number): Promise<DockerLogSnapshot> {
  const doc = await query(transport, `${agentKey}/docker/logs`, { container_id: id, tail });
  if (doc.container_id !== id || doc.tail !== tail || typeof doc.text !== "string" || doc.text.length > 65536 ||
    typeof doc.truncated !== "boolean" || typeof doc.at_unix_s !== "number" || !Number.isFinite(doc.at_unix_s)) {
    throw new Error("Invalid Docker log snapshot");
  }
  return doc as unknown as DockerLogSnapshot;
}

/** Render as plain text; remove terminal escape/control sequences (including OSC hyperlinks). */
export function plainLog(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function containerLabel(c: DockerContainer): string {
  const service = [c.project, c.service].filter(Boolean).join(" / ");
  return `${service ? `${service} — ` : ""}${c.name} (${c.state})`;
}
