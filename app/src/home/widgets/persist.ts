// Per-widget memory in localStorage: a runtime choice (the picked stream, a deck's layout) survives
// a reload without becoming config. Every read and write is guarded — storage can be absent, full,
// or throwing (private windows, previews) — and a widget must render correctly with nothing stored.

export function loadChoice<T>(key: string, check: (v: unknown) => v is T): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return check(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveChoice(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* no storage: the choice lasts for this page only */
  }
}

/** A widget's memory key: its label when it has one, else the given fallback — two unlabeled
 *  tiles of one type share memory, which is the documented reason to label them. */
export function widgetKey(kind: string, label: string | undefined, fallback: string): string {
  return `dashboard.widget.${kind}.${label ?? fallback}`;
}
