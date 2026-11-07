/**
 * A bank statement checked against the books (the user, 2026-11-07: "upload the statement and the system checks it —
 * if it is right it reconciles, otherwise it says which transaction is wrong and by how much").
 *
 * Every statement line is paired with at most one line in the account, and every line with at most one statement
 * line — never two on one — in this order, each pass taking only what the ones before left:
 *   0. pairs recorded before (a statement line with its book line and the bank charge recorded for the difference);
 *   1. the same amount, the references agreeing, within the window of days;
 *   2. the same amount, the nearest day within the window (the words alike first, when two are as near);
 *   3. not the same amount, but the same transaction — the references agreeing, or the same day and the words alike —
 *      "amount differs", with the difference;
 * then a statement line left is "not in the books", and a book line in the period left is "not on the statement".
 * Pure: no database, so it is tested on its own.
 */

export interface StatementLine {
  index: number;
  date: string; // YYYY-MM-DD
  amountMinor: number; // money in +, money out −
  reference: string;
  description: string;
}

export interface BookLine {
  id: string;
  date: string; // YYYY-MM-DD
  amountMinor: number;
  reference: string;
  description: string;
}

export type StatementMatchStatus = "matched" | "amount_differs" | "not_in_books";

export interface StatementMatch {
  index: number;
  status: StatementMatchStatus;
  bookLineIds: string[];
  /** Statement minus books, on an amount that differs. */
  differenceMinor?: number;
}

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string) => new Set(clean(s).split(" ").filter((w) => w.length >= 3));

/** A reference on one side found on the other — its reference or its words — at least four characters of it. */
export function referencesAgree(s: { reference: string; description: string }, b: { reference: string; description: string }): boolean {
  const sr = clean(s.reference).replace(/ /g, ""), br = clean(b.reference).replace(/ /g, "");
  const sd = clean(s.description).replace(/ /g, ""), bd = clean(b.description).replace(/ /g, "");
  if (sr.length >= 4 && br.length >= 4 && (sr === br || sr.includes(br) || br.includes(sr))) return true;
  if (br.length >= 4 && sd.includes(br)) return true;
  if (sr.length >= 4 && bd.includes(sr)) return true;
  return false;
}

/** How alike two descriptions are: the share of the shorter one's words in the other. */
export function likeness(a: string, b: string): number {
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

export function matchStatement(
  statement: StatementLine[],
  book: BookLine[],
  opts: { windowDays: number; pairs?: Array<{ index: number; bookLineIds: string[] }> },
): { results: StatementMatch[]; unmatchedBookIds: string[] } {
  const used = new Set<string>();
  const byId = new Map(book.map((b) => [b.id, b]));
  const results = new Map<number, StatementMatch>();
  const free = () => book.filter((b) => !used.has(b.id));
  const near = (s: StatementLine, b: BookLine) => days(s.date, b.date) <= opts.windowDays;

  // 0. Pairs recorded before, while every line in them is still there and they still add up.
  for (const p of opts.pairs ?? []) {
    const s = statement.find((x) => x.index === p.index);
    const lines = p.bookLineIds.map((id) => byId.get(id));
    if (!s || results.has(s.index) || lines.some((l) => !l || used.has(l.id))) continue;
    if (lines.reduce((t, l) => t + l!.amountMinor, 0) !== s.amountMinor) continue;
    for (const l of lines) used.add(l!.id);
    results.set(s.index, { index: s.index, status: "matched", bookLineIds: p.bookLineIds });
  }

  const pass = (pick: (s: StatementLine, candidates: BookLine[]) => BookLine | undefined, status: StatementMatchStatus) => {
    for (const s of statement) {
      if (results.has(s.index)) continue;
      const b = pick(s, free());
      if (!b) continue;
      used.add(b.id);
      results.set(s.index, {
        index: s.index, status, bookLineIds: [b.id],
        ...(status === "amount_differs" ? { differenceMinor: s.amountMinor - b.amountMinor } : {}),
      });
    }
  };
  const nearest = (s: StatementLine, list: BookLine[]) => [...list].sort((a, b) =>
    days(s.date, a.date) - days(s.date, b.date) || likeness(s.description, b.description) - likeness(s.description, a.description) || a.id.localeCompare(b.id))[0];

  // 1. Same amount, the references agreeing.
  pass((s, c) => nearest(s, c.filter((b) => b.amountMinor === s.amountMinor && near(s, b) && referencesAgree(s, b))), "matched");
  // 2. Same amount, the nearest day.
  pass((s, c) => nearest(s, c.filter((b) => b.amountMinor === s.amountMinor && near(s, b))), "matched");
  // 3. Another amount, the same transaction: one direction, and the references agreeing or the same day with the words alike.
  pass((s, c) => {
    const same = c.filter((b) => Math.sign(b.amountMinor) === Math.sign(s.amountMinor) && near(s, b)
      && (referencesAgree(s, b) || (days(s.date, b.date) === 0 && likeness(s.description, b.description) >= 0.5)));
    return [...same].sort((a, b) => Math.abs(s.amountMinor - a.amountMinor) - Math.abs(s.amountMinor - b.amountMinor) || days(s.date, a.date) - days(s.date, b.date))[0];
  }, "amount_differs");

  for (const s of statement) if (!results.has(s.index)) results.set(s.index, { index: s.index, status: "not_in_books", bookLineIds: [] });
  return {
    results: statement.map((s) => results.get(s.index)!),
    unmatchedBookIds: book.filter((b) => !used.has(b.id)).map((b) => b.id),
  };
}
