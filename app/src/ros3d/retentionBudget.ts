/** App-wide conservative CPU/GPU scan reservation. Evictions notify the owning view. */
export class RetentionBudget {
  private entries = new Map<object, { bytes: number; evict: () => void }>();
  used = 0;
  constructor(readonly limit = 128 * 1024 * 1024) {}
  reserve(bytes: number, evict: () => void): (() => void) | undefined {
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.limit) return undefined;
    while (this.used + bytes > this.limit) {
      const [key, old] = this.entries.entries().next().value!;
      this.entries.delete(key); this.used -= old.bytes; old.evict();
    }
    const key = {}; this.entries.set(key, { bytes, evict }); this.used += bytes;
    return () => { const entry = this.entries.get(key); if (entry) { this.used -= entry.bytes; this.entries.delete(key); } };
  }
}
