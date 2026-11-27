/*
 * A short-lived memo for the heavy read-only reports (Phase 7, 2026-11-28, approved): the same organization, report
 * and period asked again within 60 seconds gets the answer already worked out — Root's dashboards ask several reports
 * that share the same underlying work. Read-only figures only; nothing is written, so the worst case is a figure up to
 * a minute old. `fresh` (Root's Refresh) always works it out again. One process, in memory, at most 200 entries.
 */
const TTL_MS = 60_000;
const MAX = 200;
const store = new Map<string, { at: number; value: Promise<unknown> }>();

export function cached<T>(key: string, work: () => Promise<T>, fresh = false): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (!fresh && hit && now - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = work();
  store.set(key, { at: now, value });
  // A failed answer is not kept.
  value.catch(() => { if (store.get(key)?.value === value) store.delete(key); });
  if (store.size > MAX) store.delete(store.keys().next().value as string);
  return value;
}

/** Only for tests: forget everything. */
export const clearReportCache = () => store.clear();
