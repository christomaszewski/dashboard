import type { RosGraph } from "../ros/graph";
import type { Transport } from "../transport/types";
import { callService } from "../services/callService";

export function bagPlayers(graph: RosGraph, domain: number): string[] {
  return [...new Set(graph.services.filter((s) => s.typeName === "rosbag2_interfaces/srv/Seek" && s.name.endsWith("/seek") &&
    s.servers.some((p) => p.domainId === domain)).map((s) => s.name.slice(0, -5)))].sort();
}
export function rosTimeInput(text: string): { sec: number; nanosec: number } {
  if (!/^\d+(\.\d{1,9})?$/.test(text.trim())) throw new Error("Enter ROS seconds, with at most 9 decimal places");
  const [sec, fraction = ""] = text.trim().split("."); const seconds = Number(sec);
  if (!Number.isSafeInteger(seconds) || seconds > 2147483647) throw new Error("ROS seconds are out of range");
  return { sec: seconds, nanosec: Number(fraction.padEnd(9, "0")) };
}

/** Cooperative replay snapshots fence transport data; native players reset worker/scene state. */
export async function seekPlayer(transport: Transport, graph: RosGraph, base: string, domain: number,
  time: { sec: number; nanosec: number }, reset: () => void): Promise<void> {
  const opts = { domainId: domain };
  const state = await callService(transport, graph, `${base}/is_paused`, {}, opts);
  const paused = state.response.paused;
  if (typeof paused !== "boolean") throw new Error("player returned no paused state");
  if (!paused) await callService(transport, graph, `${base}/pause`, {}, opts);
  reset();
  try {
    const reply = await callService(transport, graph, `${base}/seek`, { time }, opts);
    if (reply.response.success === false) throw new Error("player rejected seek");
  } finally {
    if (!paused) await callService(transport, graph, `${base}/resume`, {}, opts);
  }
}
