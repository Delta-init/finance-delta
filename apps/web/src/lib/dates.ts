/*
 * Dates typed and shown as dd/mm/yyyy, whatever the browser's language (the user, 2026-11-11: "Petty cash date format
 * issue (shows dd/mm/yyyy - actually happening mm/dd/yyyy)"). A native date box takes its order from the browser — on
 * an English (US) browser it is mm/dd/yyyy, so 05/11 typed as the 5th of November was saved as the 11th of May. Values
 * stay "YYYY-MM-DD" everywhere else; only what a person types and reads is dd/mm/yyyy. No React here, so it can be
 * checked on its own (dates.test.ts).
 */

const DUBAI_MS = 4 * 60 * 60 * 1000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today in Dubai, "YYYY-MM-DD" — not the UTC day, which is still yesterday before 4 am in Dubai. */
export function todayDubai(now: Date = new Date()): string {
  return new Date(now.getTime() + DUBAI_MS).toISOString().slice(0, 10);
}

/** A real calendar day? */
function isDay(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-05" (or a full ISO time) → "05/11/2026"; "" when it isn't a date. */
export function toDmy(iso: string | null | undefined): string {
  const m = ISO.exec(String(iso ?? "").slice(0, 10));
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * What a person typed → "YYYY-MM-DD", or null when it isn't a whole, real date. Day first: 5/11/2026, 05-11-2026,
 * 05.11.2026, 05112026; a two-digit year is 20xx. "2026-11-05" is taken as it is.
 */
export function parseDmy(text: string): string | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const iso = ISO.exec(t);
  if (iso) return isDay(+iso[1]!, +iso[2]!, +iso[3]!) ? t : null;
  let d: number, mo: number, y: number;
  const parts = /^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2}|\d{4})$/.exec(t);
  if (parts) {
    d = +parts[1]!; mo = +parts[2]!; y = +parts[3]!;
    if (parts[3]!.length === 2) y += 2000;
  } else if (/^\d{8}$/.test(t)) {
    d = +t.slice(0, 2); mo = +t.slice(2, 4); y = +t.slice(4);
  } else return null;
  return isDay(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

/** While typing: digits only, the slashes put in — "0511" → "05/11", "05112026" → "05/11/2026". */
export function maskDmy(text: string): string {
  const raw = String(text ?? "");
  // Separators typed by hand are kept as they are ("5/11/2026" stays), only bare digits are shaped.
  if (/[/.\-\s]/.test(raw)) return raw.replace(/[^\d/.\-\s]/g, "").slice(0, 10);
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}
