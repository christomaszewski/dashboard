import { useState, type ReactNode } from "react";

// Renders a decoded ROS message: plain objects/arrays expandable, primitives inline. Decoded values
// include bigint (int64 fields) and TypedArrays (e.g. Image.data) — JSON.stringify chokes on both,
// hence a bespoke tree. Expand state lives per-node (useState), so it survives the live re-renders
// of a subscribed topic; node identity is the field path (React key), stable across messages.

const mono = { fontFamily: "ui-monospace, monospace", fontSize: ".8rem" } as const;
const dim = { color: "#888" } as const;

const MAX_ARRAY_ITEMS = 50;
const MAX_STRING = 160;

function isTypedArray(v: unknown): v is ArrayBufferView & { length: number } {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

function formatPrimitive(v: unknown): string {
  switch (typeof v) {
    case "bigint":
      return v.toString();
    case "number":
      return Number.isInteger(v) ? String(v) : v.toPrecision(7).replace(/\.?0+$/, "");
    case "string":
      return v.length > MAX_STRING ? JSON.stringify(v.slice(0, MAX_STRING)) + `… (${v.length} chars)` : JSON.stringify(v);
    case "boolean":
      return String(v);
    case "undefined":
      return "undefined";
    default:
      return v === null ? "null" : String(v);
  }
}

function TypedArrayValue({ value }: { value: ArrayBufferView & { length: number } }) {
  const name = value.constructor.name;
  const arr = value as unknown as ArrayLike<number | bigint>;
  const head = Array.from({ length: Math.min(8, value.length) }, (_, i) => formatPrimitive(arr[i])).join(", ");
  return (
    <span style={dim}>
      {name}({value.length}) [{head}
      {value.length > 8 ? ", …" : ""}]
    </span>
  );
}

function Expandable({ label, summary, defaultOpen, children }: { label: ReactNode; summary: string; defaultOpen: boolean; children: () => ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <span onClick={() => setOpen(!open)} style={{ cursor: "pointer", userSelect: "none" }}>
        <span style={{ ...dim, display: "inline-block", width: "1em" }}>{open ? "▾" : "▸"}</span>
        {label} {!open && <span style={dim}>{summary}</span>}
      </span>
      {open && <div style={{ marginLeft: "1.25rem" }}>{children()}</div>}
    </div>
  );
}

function Node({ label, value, depth }: { label: ReactNode; value: unknown; depth: number }) {
  if (isTypedArray(value)) {
    return (
      <div>
        {label} <TypedArrayValue value={value} />
      </div>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div>
          {label} <span style={dim}>[]</span>
        </div>
      );
    }
    return (
      <Expandable label={label} summary={`[${value.length}]`} defaultOpen={depth < 2 && value.length <= 16}>
        {() => (
          <>
            {value.slice(0, MAX_ARRAY_ITEMS).map((v, i) => (
              <Node key={i} label={<span style={dim}>{i}:</span>} value={v} depth={depth + 1} />
            ))}
            {value.length > MAX_ARRAY_ITEMS && <div style={dim}>… +{value.length - MAX_ARRAY_ITEMS} more</div>}
          </>
        )}
      </Expandable>
    );
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    return (
      <Expandable label={label} summary={`{${entries.length}}`} defaultOpen={depth < 2}>
        {() => entries.map(([k, v]) => <Node key={k} label={<span>{k}:</span>} value={v} depth={depth + 1} />)}
      </Expandable>
    );
  }
  return (
    <div>
      {label} <span style={{ color: "#16a" }}>{formatPrimitive(value)}</span>
    </div>
  );
}

export function MessageTree({ message }: { message: Record<string, unknown> }) {
  return (
    <div style={{ ...mono, lineHeight: 1.45 }}>
      {Object.entries(message).map(([k, v]) => (
        <Node key={k} label={<span>{k}:</span>} value={v} depth={0} />
      ))}
    </div>
  );
}
