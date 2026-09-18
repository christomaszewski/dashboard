// Request FORMS: from a service's root-first request definitions (the same list the CDR writer
// uses) to a flat list of editable fields, their zero/default values, and the parsing of what an
// operator typed back into the value the writer expects. Pure — the widget owns the state.
import type { MessageDefinition, MessageDefinitionField } from "@foxglove/message-definition";

export type FieldKind = "bool" | "int" | "float" | "string" | "json";

export interface FieldSpec {
  name: string;
  /** ROS type as declared (`bool`, `int32`, `string`, `builtin_interfaces/Time`, `float64[]` …). */
  type: string;
  kind: FieldKind; // json = arrays and nested messages, edited as JSON text
  /** int64 / uint64: the writer takes a bigint. */
  big: boolean;
  /** What the form starts with: the declared default, else the type's zero value. */
  initial: unknown;
}

/** rosidl gives an EMPTY message one placeholder byte under this name so CDR has something to
 *  write; it is not a field an operator fills in or reads (the writer zero-fills it). */
export const EMPTY_STRUCT_PLACEHOLDER = "structure_needs_at_least_one_member";

const INTS = new Set(["int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "byte", "char"]);
const FLOATS = new Set(["float32", "float64"]);

function kindOf(f: MessageDefinitionField): FieldKind {
  if (f.isArray || f.isComplex) return "json";
  if (f.type === "bool") return "bool";
  if (INTS.has(f.type)) return "int";
  if (FLOATS.has(f.type)) return "float";
  if (f.type === "string" || f.type === "wstring") return "string";
  return "json";
}

/** The zero value of a field (what CDR would encode for an omitted one), nested types included. */
export function zeroValue(f: MessageDefinitionField, defs: MessageDefinition[]): unknown {
  if (f.isArray) {
    if (f.arrayLength === undefined) return [];
    return Array.from({ length: f.arrayLength }, () => zeroValue({ ...f, isArray: false, arrayLength: undefined }, defs));
  }
  if (f.isComplex) {
    const def = defs.find((d) => d.name === f.type);
    return def ? zeroMessage(def, defs) : {};
  }
  if (f.type === "bool") return false;
  if (f.type === "string" || f.type === "wstring") return "";
  if (f.type === "int64" || f.type === "uint64") return 0n;
  return 0;
}

export function zeroMessage(def: MessageDefinition, defs: MessageDefinition[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.definitions) if (!f.isConstant) out[f.name] = zeroValue(f, defs);
  return out;
}

/** The editable fields of a request (constants skipped), root definition first in `defs`. */
export function fieldSpecs(defs: MessageDefinition[]): FieldSpec[] {
  const root = defs[0];
  if (!root) return [];
  return root.definitions
    .filter((f) => !f.isConstant && f.name !== EMPTY_STRUCT_PLACEHOLDER)
    .map((f) => {
      const kind = kindOf(f);
      const big = f.type === "int64" || f.type === "uint64";
      const initial = f.defaultValue !== undefined ? f.defaultValue : zeroValue(f, defs);
      return { name: f.name, type: `${f.type}${f.isArray ? (f.arrayLength !== undefined ? `[${f.arrayLength}]` : "[]") : ""}`, kind, big, initial };
    });
}

/** The text an input shows for a value (JSON for json fields, bigints as digits). */
export function fieldText(spec: FieldSpec, value: unknown): string {
  if (spec.kind === "json") return stringify(value);
  if (typeof value === "bigint") return value.toString();
  return value === undefined || value === null ? "" : String(value);
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) ?? "";
}

/** What an operator typed → the value the writer expects. Throws a readable message. */
export function parseFieldText(spec: FieldSpec, text: string): unknown {
  const t = text.trim();
  switch (spec.kind) {
    case "bool":
      if (t === "true" || t === "1") return true;
      if (t === "false" || t === "0" || t === "") return false;
      throw new Error(`${spec.name}: true or false`);
    case "int": {
      if (!/^[+-]?\d+$/.test(t)) throw new Error(`${spec.name}: an integer (${spec.type})`);
      return spec.big ? BigInt(t) : Number(t);
    }
    case "float": {
      if (t === "") return 0;
      const n = Number(t);
      if (!Number.isFinite(n)) throw new Error(`${spec.name}: a number (${spec.type})`);
      return n;
    }
    case "string":
      return text;
    case "json": {
      if (t === "") return spec.initial;
      try {
        return JSON.parse(t);
      } catch {
        throw new Error(`${spec.name}: JSON for ${spec.type}`);
      }
    }
  }
}

/** Config `request:` defaults over the zero values, keyed by field, as input TEXT. */
export function initialTexts(specs: FieldSpec[], defaults: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of specs) out[s.name] = fieldText(s, s.name in defaults ? defaults[s.name] : s.initial);
  return out;
}
