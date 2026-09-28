/**
 * When the dashboard's "waiting for your approval" pop-up may appear.
 *
 * As asked for: right after signing in, at most twice in a day, and signing in
 * again starts over. The second showing waits `SECOND_AFTER_MS` after the first
 * — without a gap, "twice a day" would be two dashboard visits in a row.
 *
 * Pure, so the rule can be tested without a browser; the component keeps the
 * state in localStorage, per person.
 */

export interface PopupState {
  /** Local calendar day the counter belongs to, YYYY-MM-DD. */
  day: string;
  /** The sign-in the counter belongs to (session.user.signedInAt). */
  signedInAt: number;
  shown: number;
  lastShownAt: number;
}

export const MAX_PER_DAY = 2;
export const SECOND_AFTER_MS = 4 * 60 * 60 * 1000;

export function localDay(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A new sign-in or a new day starts the count again. */
function isFresh(prev: PopupState | null, now: Date, signedInAt: number): boolean {
  return !prev || prev.signedInAt !== signedInAt || prev.day !== localDay(now);
}

export function shouldShowPopup(prev: PopupState | null, now: Date, signedInAt: number): boolean {
  if (isFresh(prev, now, signedInAt)) return true;
  if (prev!.shown >= MAX_PER_DAY) return false;
  return now.getTime() - prev!.lastShownAt >= SECOND_AFTER_MS;
}

export function recordShown(prev: PopupState | null, now: Date, signedInAt: number): PopupState {
  const fresh = isFresh(prev, now, signedInAt);
  return {
    day: localDay(now),
    signedInAt,
    shown: fresh ? 1 : prev!.shown + 1,
    lastShownAt: now.getTime(),
  };
}

export function readPopupState(key: string): PopupState | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as PopupState;
    return typeof v?.day === "string" && typeof v?.shown === "number" ? v : null;
  } catch {
    return null;
  }
}

export function writePopupState(key: string, state: PopupState): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Private windows and full storage: the pop-up then simply shows again,
    // which is the harmless way for this to fail.
  }
}
