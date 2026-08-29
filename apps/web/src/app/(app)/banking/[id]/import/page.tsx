"use client";

import { use, useState, useRef, useMemo, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Upload, FileText, X, CheckCircle2, AlertCircle, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import { useBankAccount, useBulkImportTransactions, usePreviewImport } from "@/features/banking/api";
import {
  parseDelimited,
  detectDelimiter,
  parseAmount,
  detectDecimalStyle,
  parseDate,
  detectDateFormats,
  DATE_FORMAT_LABELS,
  type DateFormat,
  type DecimalStyle,
} from "@delta/shared";
import type { ImportedTransactionInput } from "@delta/shared";

/**
 * Radix refuses an empty string as a Select value, so "no column chosen" needs
 * a sentinel that is not one. It never leaves this screen.
 */
const NONE = "__none__";

type ParsedRow = {
  isoDate: string;
  description: string;
  amountMinor: number;
  reference: string;
  /** Why this row cannot be imported. Empty when it is fine. */
  problems: string[];
};

type ColumnMapping = {
  date: string;
  description: string;
  amount: string;
  reference: string;
  amountType: "signed" | "separate";
  creditColumn: string;
  debitColumn: string;
};

function mapRows(
  rows: string[][],
  headers: string[],
  mapping: ColumnMapping,
  dateFormat: DateFormat,
  decimalStyle: DecimalStyle,
): ParsedRow[] {
  return rows.map((row) => {
    const get = (col: string) => {
      if (!col || col === NONE) return "";
      const idx = headers.indexOf(col);
      return idx >= 0 ? (row[idx] ?? "") : "";
    };
    const problems: string[] = [];

    // A row with a different number of fields than the header means the file
    // is not shaped the way it claims — usually an unquoted separator inside a
    // description. Every column after it has shifted, so the amount would be
    // read out of a neighbouring cell. That is exactly the failure worth
    // refusing: it produces a plausible number rather than an error.
    if (row.length !== headers.length) {
      problems.push(`Row has ${row.length} fields, header has ${headers.length}`);
    }

    const date = parseDate(get(mapping.date), dateFormat);
    if (!date.ok) problems.push(date.reason ?? "Bad date");

    let amountMinor = 0;
    if (mapping.amountType === "signed") {
      const amt = parseAmount(get(mapping.amount), decimalStyle);
      if (!amt.ok) problems.push(amt.reason ?? "Bad amount");
      amountMinor = amt.minor;
    } else {
      // Money out is written as a positive number in a debit column, so its
      // sign comes from the column it sits in, not from the value.
      const credit = parseAmount(get(mapping.creditColumn), decimalStyle);
      const debit = parseAmount(get(mapping.debitColumn), decimalStyle);
      if (!credit.ok) problems.push(credit.reason ?? "Bad credit amount");
      if (!debit.ok) problems.push(debit.reason ?? "Bad debit amount");
      amountMinor = credit.minor - Math.abs(debit.minor);
    }

    const description = get(mapping.description).trim();
    if (!description) problems.push("No description");
    if (problems.length === 0 && amountMinor === 0) {
      problems.push("Amount is zero — check the column mapping");
    }

    return {
      isoDate: date.iso,
      description,
      amountMinor,
      reference: get(mapping.reference).trim(),
      problems,
    };
  });
}

export default function ImportTransactionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: account } = useBankAccount(id);
  const bulkImport = useBulkImportTransactions(id);
  const preview = usePreviewImport(id);

  const fileRef = useRef<HTMLInputElement>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [fileName, setFileName] = useState("");
  const [step, setStep] = useState<"upload" | "map" | "preview" | "done">("upload");

  const [dateFormat, setDateFormat] = useState<DateFormat>("dmy");
  const [decimalStyle, setDecimalStyle] = useState<DecimalStyle>("dot");
  /** True when the file did not settle the layout and the choice is a guess. */
  const [dateAmbiguous, setDateAmbiguous] = useState(false);

  const [duplicates, setDuplicates] = useState<Set<number>>(new Set());
  const [onDuplicate, setOnDuplicate] = useState<"skip" | "import">("skip");
  const [result, setResult] = useState<{ count: number; skipped: number } | null>(null);

  const [mapping, setMapping] = useState<ColumnMapping>({
    date: "", description: "", amount: "", reference: NONE,
    amountType: "signed", creditColumn: "", debitColumn: "",
  });

  const parsed = useMemo(
    () => (headers.length ? mapRows(rows, headers, mapping, dateFormat, decimalStyle) : []),
    [rows, headers, mapping, dateFormat, decimalStyle],
  );
  const good = useMemo(() => parsed.filter((r) => r.problems.length === 0), [parsed]);
  const bad = parsed.length - good.length;

  /** Indexes into `good`, which is what gets sent and what the server answers about. */
  const importable = useMemo(
    () => (onDuplicate === "skip" ? good.filter((_, i) => !duplicates.has(i)) : good),
    [good, duplicates, onDuplicate],
  );

  function column(col: string) {
    return rows.map((r) => {
      const idx = headers.indexOf(col);
      return idx >= 0 ? (r[idx] ?? "") : "";
    });
  }

  // Re-detect whenever the chosen column changes: the layout is a property of
  // the column, and carrying the previous column's answer over is how a file
  // gets read in a format that was never checked against it.
  useEffect(() => {
    if (!mapping.date || !headers.length) return;
    const formats = detectDateFormats(column(mapping.date));
    setDateAmbiguous(formats.length !== 1);
    if (formats.length >= 1) setDateFormat(formats[0]!);
  }, [mapping.date, headers, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cols = mapping.amountType === "signed"
      ? [mapping.amount]
      : [mapping.creditColumn, mapping.debitColumn];
    const samples = cols.filter((c) => c && c !== NONE).flatMap(column);
    if (!samples.length) return;
    const style = detectDecimalStyle(samples);
    if (style !== "ambiguous") setDecimalStyle(style);
  }, [mapping.amount, mapping.creditColumn, mapping.debitColumn, mapping.amountType, headers, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) ?? "";
      const all = parseDelimited(text, detectDelimiter(text));
      if (all.length < 2) {
        toast.error("That file has no rows under its header");
        return;
      }
      const [head, ...body] = all;
      setHeaders(head!);
      setRows(body);
      const guess = (words: string[]) =>
        head!.find((h) => words.some((w) => h.toLowerCase().includes(w))) ?? "";
      setMapping({
        date: guess(["date"]),
        description: guess(["description", "narration", "detail", "particular", "remark"]),
        amount: guess(["amount", "value"]),
        reference: guess(["reference", "ref", "cheque", "check"]) || NONE,
        amountType: "signed",
        creditColumn: guess(["credit", "deposit"]),
        debitColumn: guess(["debit", "withdraw"]),
      });
      setStep("map");
    };
    reader.readAsText(file);
  }

  async function goToPreview() {
    const rowsToCheck = good;
    if (rowsToCheck.length === 0) {
      toast.error("No rows could be read with this mapping");
      return;
    }
    try {
      const res = await preview.mutateAsync({
        transactions: rowsToCheck.map((r) => ({
          date: r.isoDate, description: r.description,
          amountMinor: r.amountMinor, reference: r.reference, notes: "",
        })),
      });
      setDuplicates(new Set(res.duplicates));
    } catch {
      // Not fatal: the import itself checks again, and refuses to double up.
      setDuplicates(new Set());
      toast.error("Could not check for duplicates — the import will still skip them");
    }
    setStep("preview");
  }

  async function handleImport() {
    try {
      const transactions: ImportedTransactionInput[] = good.map((r) => ({
        date: r.isoDate, description: r.description,
        amountMinor: r.amountMinor, reference: r.reference, notes: "",
      }));
      const res = await bulkImport.mutateAsync({
        transactions,
        importBatchId: `import-${Date.now()}`,
        onDuplicate,
      });
      setResult({ count: res.count, skipped: res.skipped });
      setStep("done");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Import failed");
    }
  }

  function reset() {
    setStep("upload"); setHeaders([]); setRows([]); setFileName("");
    setDuplicates(new Set()); setResult(null);
  }

  const mappingComplete =
    mapping.date && mapping.description &&
    (mapping.amountType === "signed" ? mapping.amount : mapping.creditColumn && mapping.debitColumn);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/banking/${id}`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-semibold">Import Transactions</h1>
          <p className="text-sm text-foreground-muted">
            {account ? `${account.accountName} · ${account.currency}` : "Loading…"}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm">
        {(["upload", "map", "preview"] as const).map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            {i > 0 && <span className="text-foreground-subtle">›</span>}
            <span
              className={
                step === s
                  ? "font-semibold text-foreground"
                  : ["upload", "map", "preview"].indexOf(step) > i
                    ? "text-success"
                    : "text-foreground-muted"
              }
            >
              {i + 1}. {s.charAt(0).toUpperCase() + s.slice(1)}
            </span>
          </span>
        ))}
      </div>

      {step === "upload" && (
        <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-surface p-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-muted">
            <Upload className="h-8 w-8 text-foreground-subtle" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground">Upload a statement</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-foreground-muted">
              A CSV export from your bank. Commas, semicolons and tabs are all read, and you
              confirm the date and number format on the next step before anything is imported.
            </p>
          </div>
          <Button onClick={() => fileRef.current?.click()}>
            <FileText className="h-4 w-4" /> Choose file
          </Button>
          <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" className="hidden" onChange={handleFileChange} />
        </div>
      )}

      {step === "map" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4">
            <FileText className="h-5 w-5 shrink-0 text-foreground-muted" />
            <span className="text-sm font-medium">{fileName}</span>
            <span className="text-xs text-foreground-muted">
              ({rows.length} rows, {headers.length} columns)
            </span>
            <button onClick={reset} className="ml-auto text-foreground-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4 rounded-lg border border-border bg-surface p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground-muted">
              Map Columns
            </h2>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Date column *</Label>
                <Select value={mapping.date} onValueChange={(v) => setMapping((m) => ({ ...m, date: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                  <SelectContent>
                    {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>Description column *</Label>
                <Select value={mapping.description} onValueChange={(v) => setMapping((m) => ({ ...m, description: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                  <SelectContent>
                    {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>Reference column (optional)</Label>
                <Select value={mapping.reference} onValueChange={(v) => setMapping((m) => ({ ...m, reference: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>Amount format</Label>
                <Select
                  value={mapping.amountType}
                  onValueChange={(v) => setMapping((m) => ({ ...m, amountType: v as "signed" | "separate" }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="signed">Single column (+ credit, − debit)</SelectItem>
                    <SelectItem value="separate">Separate credit/debit columns</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {mapping.amountType === "signed" ? (
                <div className="space-y-1">
                  <Label>Amount column *</Label>
                  <Select value={mapping.amount} onValueChange={(v) => setMapping((m) => ({ ...m, amount: v }))}>
                    <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                    <SelectContent>
                      {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label>Credit (money in) *</Label>
                    <Select value={mapping.creditColumn} onValueChange={(v) => setMapping((m) => ({ ...m, creditColumn: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>
                        {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Debit (money out) *</Label>
                    <Select value={mapping.debitColumn} onValueChange={(v) => setMapping((m) => ({ ...m, debitColumn: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>
                        {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Date and number format. Separated out because getting either wrong
              changes the numbers without looking like an error. */}
          <div className="space-y-4 rounded-lg border border-border bg-surface p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground-muted">
              Date &amp; number format
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Date format</Label>
                <Select value={dateFormat} onValueChange={(v) => setDateFormat(v as DateFormat)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(DATE_FORMAT_LABELS) as DateFormat[]).map((f) => (
                      <SelectItem key={f} value={f}>{DATE_FORMAT_LABELS[f]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {mapping.date && (
                  <p className={`text-xs ${dateAmbiguous ? "text-warning" : "text-foreground-muted"}`}>
                    {dateAmbiguous
                      ? "Every day in this file is 12 or under, so the order cannot be told from the file. Check the first date below."
                      : "Detected from the file."}
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <Label>Number format</Label>
                <Select value={decimalStyle} onValueChange={(v) => setDecimalStyle(v as DecimalStyle)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dot">1,234.56 — comma thousands</SelectItem>
                    <SelectItem value="comma">1.234,56 — dot thousands</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* The first row as it will actually be stored. Cheaper to check
                one line here than to unpick a month of wrong dates later. */}
            {mappingComplete && parsed[0] && (
              <div className="rounded-md border border-border bg-surface-muted/40 p-3 text-sm">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  First row reads as
                </p>
                {parsed[0].problems.length > 0 ? (
                  <p className="text-danger">{parsed[0].problems.join(" · ")}</p>
                ) : (
                  <p className="font-mono">
                    {parsed[0].isoDate} · {parsed[0].description} ·{" "}
                    <span className={parsed[0].amountMinor >= 0 ? "text-success" : "text-danger"}>
                      {parsed[0].amountMinor >= 0 ? "+" : "−"}
                      {Math.abs(parsed[0].amountMinor / 100).toFixed(2)}
                    </span>
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3">
            <Button variant="outline" onClick={reset}>Back</Button>
            <Button onClick={goToPreview} disabled={!mappingComplete || preview.isPending}>
              {preview.isPending ? "Checking…" : "Preview Import"}
            </Button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
            <span className="text-sm font-medium">
              {importable.length} transaction{importable.length === 1 ? "" : "s"} ready
            </span>
            {duplicates.size > 0 && (
              <span className="flex items-center gap-1 text-xs text-warning">
                <Copy className="h-3.5 w-3.5" /> {duplicates.size} already on this account
              </span>
            )}
            {bad > 0 && (
              <span className="flex items-center gap-1 text-xs text-danger">
                <AlertCircle className="h-3.5 w-3.5" /> {bad} unreadable, left out
              </span>
            )}
          </div>

          {duplicates.size > 0 && (
            <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-4">
              <p className="text-sm font-medium">
                {duplicates.size} of these are already on the account
              </p>
              <p className="text-xs text-foreground-muted">
                Matched on date, amount, description and reference. Two genuinely separate
                payments of the same amount on the same day look identical here, so if that is
                what these are, import them.
              </p>
              <Select value={onDuplicate} onValueChange={(v) => setOnDuplicate(v as "skip" | "import")}>
                <SelectTrigger className="w-[280px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">Leave the {duplicates.size} out</SelectItem>
                  <SelectItem value="import">Import them, marked as duplicates</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {bad > 0 && (
            <div className="rounded-lg border border-danger/40 bg-danger/5 p-4">
              <p className="mb-2 text-sm font-medium">{bad} row{bad === 1 ? "" : "s"} could not be read</p>
              <ul className="space-y-1 text-xs text-foreground-muted">
                {parsed
                  .map((r, i) => ({ r, i }))
                  .filter(({ r }) => r.problems.length > 0)
                  .slice(0, 5)
                  .map(({ r, i }) => (
                    <li key={i}>Row {i + 2}: {r.problems.join(" · ")}</li>
                  ))}
                {bad > 5 && <li>…and {bad - 5} more</li>}
              </ul>
              <p className="mt-2 text-xs text-foreground-muted">
                Go back and check the date or number format if this is most of the file.
              </p>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <div className="max-h-[480px] overflow-y-auto overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-muted">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-foreground-muted">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-foreground-muted">Description</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-foreground-muted">Reference</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-foreground-muted">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {good.map((row, i) => {
                    const dup = duplicates.has(i);
                    return (
                      <tr
                        key={i}
                        className={`border-t border-border hover:bg-surface-muted/50 ${
                          dup && onDuplicate === "skip" ? "opacity-40" : ""
                        }`}
                      >
                        <td className="px-4 py-2.5 text-foreground-muted">{row.isoDate}</td>
                        <td className="max-w-xs truncate px-4 py-2.5">
                          {row.description}
                          {dup && (
                            <span className="ml-2 inline-flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                              <Copy className="h-2.5 w-2.5" /> already here
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-foreground-muted">{row.reference}</td>
                        <td
                          className={`px-4 py-2.5 text-right font-mono font-medium ${
                            row.amountMinor >= 0 ? "text-success" : "text-danger"
                          }`}
                        >
                          {row.amountMinor >= 0 ? "+" : "−"}
                          {Math.abs(row.amountMinor / 100).toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            <Button variant="outline" onClick={() => setStep("map")}>Back</Button>
            <Button onClick={handleImport} disabled={bulkImport.isPending || importable.length === 0}>
              {bulkImport.isPending ? "Importing…" : `Import ${importable.length} transactions`}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-surface p-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-success/10">
            <CheckCircle2 className="h-8 w-8 text-success" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground">Import complete</h2>
            <p className="mt-1 text-sm text-foreground-muted">
              {result?.count ?? 0} transaction{result?.count === 1 ? "" : "s"} added
              {result?.skipped ? `, ${result.skipped} skipped as already present` : ""}.
            </p>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={reset}>Import more</Button>
            <Button onClick={() => router.push(`/banking/${id}`)}>View transactions</Button>
          </div>
        </div>
      )}
    </div>
  );
}
