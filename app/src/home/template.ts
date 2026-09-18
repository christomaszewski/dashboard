// Readout format strings: literal text with `{dot.path}` placeholders resolved against a decoded
// message, `{dot.path:.Nf}` for N decimals. `{{` / `}}` are literal braces. Parsed once at config
// time (errors are config errors), rendered per message: a placeholder whose path is absent renders
// `?` and is reported, so a wrong path is visible instead of blank.
import { pluckField } from "./pluck";
import { formatValue } from "./value";

export type TemplatePart = { text: string } | { path: string; precision?: number };

export interface Template {
  source: string;
  parts: TemplatePart[];
  /** Every placeholder path, in order (for the detail line / tests). */
  paths: string[];
}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const SPEC_RE = /^\.(\d{1,2})f$/;

export function parseTemplate(source: string): Template {
  const parts: TemplatePart[] = [];
  const paths: string[] = [];
  let text = "";
  let i = 0;
  const flush = () => {
    if (text) parts.push({ text });
    text = "";
  };
  while (i < source.length) {
    const c = source[i];
    if (c === "{") {
      if (source[i + 1] === "{") {
        text += "{";
        i += 2;
        continue;
      }
      const end = source.indexOf("}", i + 1);
      if (end < 0) throw new Error(`format: unclosed '{' at ${i} in "${source}"`);
      const body = source.slice(i + 1, end);
      const colon = body.indexOf(":");
      const path = (colon < 0 ? body : body.slice(0, colon)).trim();
      const spec = colon < 0 ? undefined : body.slice(colon + 1).trim();
      if (!PATH_RE.test(path)) throw new Error(`format: '{${body}}' is not a field path (letters, digits, '_' and '.')`);
      let precision: number | undefined;
      if (spec !== undefined) {
        const m = SPEC_RE.exec(spec);
        if (!m) throw new Error(`format: '{${body}}' — the only format spec is '.Nf' (N decimals)`);
        precision = Number(m[1]);
      }
      flush();
      parts.push({ path, precision });
      paths.push(path);
      i = end + 1;
      continue;
    }
    if (c === "}" && source[i + 1] === "}") {
      text += "}";
      i += 2;
      continue;
    }
    if (c === "}") throw new Error(`format: stray '}' at ${i} in "${source}" (write '}}' for a literal brace)`);
    text += c;
    i++;
  }
  flush();
  if (paths.length === 0) throw new Error(`format: no {field} placeholder in "${source}"`);
  return { source, parts, paths };
}

export interface Rendered {
  text: string;
  /** Placeholder paths the message did not have (rendered as `?`). */
  missing: string[];
}

export function renderTemplate(t: Template, msg: unknown): Rendered {
  const missing: string[] = [];
  let text = "";
  for (const p of t.parts) {
    if ("text" in p) {
      text += p.text;
      continue;
    }
    const v = pluckField(msg, p.path);
    if (v === undefined) {
      missing.push(p.path);
      text += "?";
    } else text += formatValue(v, p.precision);
  }
  return { text, missing };
}
