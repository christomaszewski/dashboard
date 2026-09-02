// Declarative value → (level, text) rules for the `indicator` widget. Pure; unit-tested.
//
//   rules:
//     - { equals: true, level: ok, text: ARMED }
//     - { below: 20, level: err, text: LOW }
//     - { between: [20, 80], level: warn }
//     - { in: [GUIDED, AUTO], level: ok }
//     - { matches: "^RTK", level: ok, text: RTK }
//   default: { level: idle, text: "?" }
//
// First rule whose conditions ALL hold wins; no match → default (or idle). Comparisons are strict
// (YAML `true` ≠ `"true"`, `1` ≠ `"1"`) except bigint decoded values, which compare as numbers.
import { isObj, optStr, type Obj } from "../../../widgets/parse";

export type Level = "ok" | "warn" | "err" | "idle";
const LEVELS: readonly Level[] = ["ok", "warn", "err", "idle"];

export interface IndicatorRule {
  equals?: unknown;
  not_equals?: unknown;
  below?: number;
  above?: number;
  between?: [number, number];
  in?: unknown[];
  matches?: string; // regex source, tested against String(value)
  level: Level;
  text?: string;
}

export interface IndicatorOutcome {
  level: Level;
  /** Rule text when given; otherwise undefined (callers format the raw value). */
  text?: string;
}

const CONDITION_KEYS = ["equals", "not_equals", "below", "above", "between", "in", "matches"] as const;

function normalize(v: unknown): unknown {
  return typeof v === "bigint" ? Number(v) : v;
}

function asNumber(v: unknown): number | undefined {
  const n = normalize(v);
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function equal(a: unknown, b: unknown): boolean {
  return normalize(a) === normalize(b);
}

/** Does this rule's every condition hold for the value? A rule with no conditions never matches. */
export function ruleMatches(rule: IndicatorRule, value: unknown): boolean {
  let checked = 0;
  if ("equals" in rule && rule.equals !== undefined) {
    checked++;
    if (!equal(value, rule.equals)) return false;
  }
  if ("not_equals" in rule && rule.not_equals !== undefined) {
    checked++;
    if (equal(value, rule.not_equals)) return false;
  }
  if (rule.below !== undefined) {
    checked++;
    const n = asNumber(value);
    if (n === undefined || !(n < rule.below)) return false;
  }
  if (rule.above !== undefined) {
    checked++;
    const n = asNumber(value);
    if (n === undefined || !(n > rule.above)) return false;
  }
  if (rule.between !== undefined) {
    checked++;
    const n = asNumber(value);
    if (n === undefined || n < rule.between[0] || n > rule.between[1]) return false;
  }
  if (rule.in !== undefined) {
    checked++;
    if (!rule.in.some((x) => equal(value, x))) return false;
  }
  if (rule.matches !== undefined) {
    checked++;
    if (value === undefined || value === null || !new RegExp(rule.matches).test(String(normalize(value)))) return false;
  }
  return checked > 0;
}

export function evaluateRules(value: unknown, rules: IndicatorRule[], fallback?: IndicatorOutcome): IndicatorOutcome {
  for (const rule of rules) {
    if (ruleMatches(rule, value)) return { level: rule.level, text: rule.text };
  }
  return fallback ?? { level: "idle" };
}

// ---- YAML validation ---------------------------------------------------------------------------

function parseLevel(o: Obj, key: string, where: string): Level {
  const v = o[key];
  if (typeof v !== "string" || !(LEVELS as readonly string[]).includes(v))
    throw new Error(`${where}: 'level' must be one of: ${LEVELS.join(", ")}`);
  return v as Level;
}

export function parseRule(raw: unknown, index: number): IndicatorRule {
  const where = `rules[${index}]`;
  if (!isObj(raw)) throw new Error(`${where}: must be a mapping`);
  const rule: IndicatorRule = { level: parseLevel(raw, "level", where), text: optStr(raw, "text") };
  if ("equals" in raw) rule.equals = raw.equals;
  if ("not_equals" in raw) rule.not_equals = raw.not_equals;
  for (const key of ["below", "above"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "number") throw new Error(`${where}: '${key}' must be a number`);
      rule[key] = raw[key] as number;
    }
  }
  if (raw.between !== undefined) {
    const b = raw.between;
    if (!Array.isArray(b) || b.length !== 2 || typeof b[0] !== "number" || typeof b[1] !== "number" || b[0] > b[1])
      throw new Error(`${where}: 'between' must be [low, high] numbers`);
    rule.between = [b[0], b[1]];
  }
  if (raw.in !== undefined) {
    if (!Array.isArray(raw.in) || raw.in.length === 0) throw new Error(`${where}: 'in' must be a non-empty list`);
    rule.in = raw.in;
  }
  if (raw.matches !== undefined) {
    if (typeof raw.matches !== "string") throw new Error(`${where}: 'matches' must be a regex string`);
    try {
      new RegExp(raw.matches);
    } catch (e) {
      throw new Error(`${where}: 'matches' is not a valid regex (${e instanceof Error ? e.message : String(e)})`);
    }
    rule.matches = raw.matches;
  }
  if (!CONDITION_KEYS.some((k) => k in raw && raw[k] !== undefined))
    throw new Error(`${where}: needs a condition (${CONDITION_KEYS.join(" | ")})`);
  return rule;
}

export function parseDefault(raw: unknown): IndicatorOutcome | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) throw new Error("'default' must be a mapping with 'level' (and optional 'text')");
  return { level: parseLevel(raw, "level", "default"), text: optStr(raw, "text") };
}
