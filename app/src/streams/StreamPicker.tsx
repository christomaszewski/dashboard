import type { DiscoveredStream } from "./types";

/**
 * A stream chooser: discovered streams by role, offline ones marked. `value` is the chosen key
 * (null = nothing yet — the placeholder shows); `exclude` hides keys already in use (a deck adding
 * a feed). A plain <select> on purpose: keyboard-reachable, no popover to manage, and one line in
 * a tile's chrome.
 */
export function StreamPicker({
  streams,
  value,
  onChange,
  exclude = [],
  placeholder = "select a stream…",
  title = "choose the stream",
  className = "",
}: {
  streams: DiscoveredStream[];
  value: string | null;
  onChange: (key: string) => void;
  exclude?: string[];
  placeholder?: string;
  title?: string;
  className?: string;
}) {
  const options = streams.filter((s) => !exclude.includes(s.key));
  return (
    <select
      className={`stream-picker${className ? ` ${className}` : ""}`}
      value={value ?? ""}
      title={title}
      aria-label={title}
      onChange={(e) => {
        if (e.target.value) onChange(e.target.value);
      }}
    >
      <option value="">{placeholder}</option>
      {options.map((s) => {
        const label = s.descriptor.role || s.descriptor.id;
        const dims = s.descriptor.width && s.descriptor.height ? ` ${s.descriptor.width}×${s.descriptor.height}` : "";
        return (
          <option key={s.key} value={s.key}>
            {label}
            {dims}
            {s.alive ? "" : " (offline)"}
          </option>
        );
      })}
    </select>
  );
}
