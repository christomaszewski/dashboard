// Pure YAML-mapping accessors shared by every widget spec (built-in or extension). Each returns
// undefined for absent/wrong-typed values; `reqStr` throws a message that the schema turns into
// the widget's inline error card ("widgets[3] (gauge): 'topic' is required …").

export type Obj = Record<string, unknown>;

export type WidgetSpan = 1 | 2 | "full";

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function optStr(o: Obj, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function optNum(o: Obj, key: string): number | undefined {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function optBool(o: Obj, key: string): boolean | undefined {
  const v = o[key];
  return typeof v === "boolean" ? v : undefined;
}

export function optSpan(o: Obj): WidgetSpan | undefined {
  const v = o["span"];
  return v === 1 || v === 2 || v === "full" ? v : undefined;
}

/** A list of non-empty strings (a lone string counts as a one-item list); undefined when absent or
 *  wrong-typed; a thrown message when the list holds anything but non-empty strings. */
export function optStrList(o: Obj, key: string): string[] | undefined {
  const v = o[key];
  if (typeof v === "string") return v !== "" ? [v] : undefined;
  if (!Array.isArray(v)) return undefined;
  if (!v.every((x) => typeof x === "string" && x !== "")) {
    throw new Error(`'${key}' must be a list of non-empty strings`);
  }
  return v as string[];
}

/** Required non-empty string, or a thrown message naming the key. */
export function reqStr(o: Obj, key: string): string {
  const v = optStr(o, key);
  if (v === undefined) throw new Error(`'${key}' is required and must be a non-empty string`);
  return v;
}

/** Required finite number, or a thrown message naming the key. */
export function reqNum(o: Obj, key: string): number {
  const v = optNum(o, key);
  if (v === undefined) throw new Error(`'${key}' is required and must be a number`);
  return v;
}

/** The shared warn/err threshold quartet (see home/value.ts). */
export interface Thresholds {
  warn_below?: number;
  warn_above?: number;
  err_below?: number;
  err_above?: number;
}

export function optThresholds(o: Obj): Thresholds {
  return {
    warn_below: optNum(o, "warn_below"),
    warn_above: optNum(o, "warn_above"),
    err_below: optNum(o, "err_below"),
    err_above: optNum(o, "err_above"),
  };
}
