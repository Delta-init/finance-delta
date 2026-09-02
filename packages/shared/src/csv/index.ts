/**
 * Turning rows into a CSV somebody will open in Excel.
 *
 * The escaping is the whole job. A description like `Paid "Ali", 50` splits a
 * row into three columns and shifts every figure after it one place left — and
 * a spreadsheet does not complain, it just shows the wrong numbers. So a field
 * is quoted whenever it contains a comma, a quote or a line break, and quotes
 * inside it are doubled, which is what RFC 4180 asks for and what Excel reads.
 */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/** One field, quoted only when it has to be. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  // A leading =, +, - or @ is read as a formula by Excel, so a description
  // beginning with one would execute rather than display. Prefixed with a
  // quote-and-tab so it stays text without the character disappearing.
  const risky = /^[=+\-@\t\r]/.test(s);
  const body = risky ? `'${s}` : s;
  return /[",\n\r]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => csvField(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => csvField(c.value(r))).join(","));
  // A trailing newline: some tools drop the last line without one.
  return [head, ...body].join("\r\n") + "\r\n";
}
