/**
 * Dot-path field extraction from a decoded message: `pose.pose.position.x`, numeric segments index
 * arrays/TypedArrays (`ranges.0`). Returns undefined anywhere the path doesn't apply.
 */
export function pluckField(msg: unknown, path: string): unknown {
  let cur: unknown = msg;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
