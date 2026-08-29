"use client";

import { use, useState, useRef, useMemo, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Upload, FileText, X, CheckCircle2, AlertCircle, Copy, ShieldAlert } from "lucide-react";
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
  detectHeaderRow,
  columnRefs,
  usefulColumns,
  looksLikeTotalRow,
  readStatementMeta,
  verifyBalances,
  DATE_FORMAT_LABELS,
  type DateFormat,
  type DecimalStyle,
  type ColumnRef,
  type StatementMeta,
} from "@delta/shared";
import type { ImportedTransactionInput } from "@delta/shared";

/** Radix treats an empty string as "no value", so "not chosen" needs a sentinel. */
const NONE = "__none__";

/** Columns are addressed by position; heading text does not identify them. */
const asIndex = (v: string) => (v === NONE || v === "" ? -1 : Number(v));

type ParsedRow = {
  /**
   * True when the row holds nothing in any mapped column — a note or a spacer
   * from the bottom of the sheet, not a transaction that failed to parse.
   * Reporting these as unreadable buries the rows that genuinely are.
   */
  blank: boolean;
  isoDate: string;
  description: string;
  amountMinor: number;
  reference: string;
  externalId: string;
  /** The balance the bank states after this line, when a column was mapped. */
  statedBalanceMinor?: number;
  problems: string[];
};

type ColumnMapping = {
  date: string;
  description: string;
  amount: string;
  reference: string;
  externalId: string;
  balance: string;
  amountType: "signed" | "separate";
  creditColumn: string;
  debitColumn: string;
};

const EMPTY_MAPPING: ColumnMapping = {
  date: NONE, description: NONE, amount: NONE, reference: NONE, externalId: NONE,
  balance: NONE, amountType: "signed", creditColumn: NONE, debitColumn: NONE,
};

function mapRows(
  rows: string[][],
  mapping: ColumnMapping,
  dateFormat: DateFormat,
  decimalStyle: DecimalStyle,
  columnCount: number,
): ParsedRow[] {
  return rows.map((row) => {
    const get = (col: string) => {
      const i = asIndex(col);
      return i < 0 ? "" : String(row[i] ?? "");
    };
    const problems: string[] = [];

    // Notes and disclaimers at the foot of a statement sit in their own
    // columns, so they read as empty everywhere that matters.
    const blank = [mapping.date, mapping.description, mapping.amount, mapping.creditColumn, mapping.debitColumn]
      .every((c) => get(c).trim() === "");

    // A row with more fields than the header means an unquoted separator has
    // shifted every later column, so the amount would come out of the wrong
    // cell — a plausible number rather than an error.
    if (row.length > columnCount) {
      problems.push(`Row has ${row.length} fields, header has ${columnCount}`);
    }

    const date = parseDate(get(mapping.date), dateFormat);
    if (!date.ok) problems.push(date.reason ?? "Bad date");

    let amountMinor = 0;
    if (mapping.amountType === "signed") {
      const amt = parseAmount(get(mapping.amount), decimalStyle);
      if (!amt.ok) problems.push(amt.reason ?? "Bad amount");
      amountMinor = amt.minor;
    } else {
      // Money out is written as a positive number in a withdrawals column, so
      // the sign comes from which column it sits in, not from the value.
      const credit = parseAmount(get(mapping.creditColumn), decimalStyle);
      const debit = parseAmount(get(mapping.debitColumn), decimalStyle);
      if (!credit.ok) problems.push(credit.reason ?? "Bad deposit amount");
      if (!debit.ok) problems.push(debit.reason ?? "Bad withdrawal amount");
      amountMinor = credit.minor - Math.abs(debit.minor);
    }

    const description = get(mapping.description).trim();
    if (!description) problems.push("No description");
    if (problems.length === 0 && amountMinor === 0) {
      problems.push("Amount is zero — check the column mapping");
    }

    let statedBalanceMinor: number | undefined;
    if (asIndex(mapping.balance) >= 0) {
      const b = parseAmount(get(mapping.balance), decimalStyle);
      if (b.ok) statedBalanceMinor = b.minor;
    }

    return {
      blank,
      isoDate: date.iso,
      description,
      amountMinor,
      reference: get(mapping.reference).trim(),
      externalId: get(mapping.externalId).trim(),
      statedBalanceMinor,
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
  const [sheet, setSheet] = useState<string[][]>([]);
  const [headerRow, setHeaderRow] = useState(0);
  const [fileName, setFileName] = useState("");
  const [step, setStep] = useState<"upload" | "map" | "preview" | "done">("upload");
  const [reading, setReading] = useState(false);

  const [dateFormat, setDateFormat] = useState<DateFormat>("dmy");
  const [decimalStyle, setDecimalStyle] = useState<DecimalStyle>("dot");
  const [dateAmbiguous, setDateAmbiguous] = useState(false);
  const [meta, setMeta] = useState<StatementMeta>({});

  const [duplicates, setDuplicates] = useState<Set<number>>(new Set());
  const [onDuplicate, setOnDuplicate] = useState<"skip" | "import">("skip");
  const [result, setResult] = useState<{ count: number; skipped: number } | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>(EMPTY_MAPPING);

  const headerCells = useMemo(
    () => (sheet[headerRow] ?? []).map((c) => String(c ?? "")),
    [sheet, headerRow],
  );

  /** Rows below the heading that are transactions, not totals or small print. */
  const bodyRows = useMemo(
    () => sheet.slice(headerRow + 1).filter((r) => !looksLikeTotalRow(r) && r.some((c) => String(c ?? "").trim())),
    [sheet, headerRow],
  );

  const columns: ColumnRef[] = useMemo(
    () => usefulColumns(columnRefs(headerCells), bodyRows),
    [headerCells, bodyRows],
  );

  const parsed = useMemo(
    () => (headerCells.length ? mapRows(bodyRows, mapping, dateFormat, decimalStyle, headerCells.length) : []),
    [bodyRows, headerCells, mapping, dateFormat, decimalStyle],
  );
  const good = useMemo(() => parsed.filter((r) => !r.blank && r.problems.length === 0), [parsed]);
  const bad = useMemo(() => parsed.filter((r) => !r.blank && r.problems.length > 0), [parsed]).length;

  const importable = useMemo(
    () => (onDuplicate === "skip" ? good.filter((_, i) => !duplicates.has(i)) : good),
    [good, duplicates, onDuplicate],
  );

  /** The bank's own running balance, checked against the arithmetic. */
  const balanceCheck = useMemo(() => {
    if (asIndex(mapping.balance) < 0 || meta.openingBalanceMinor === undefined || good.length === 0) return null;
    return verifyBalances(meta.openingBalanceMinor, good);
  }, [mapping.balance, meta.openingBalanceMinor, good]);

  /** True when the file names an account that is not the one being imported into. */
  const wrongAccount = useMemo(() => {
    if (!meta.accountNumber || !account?.accountNumber) return false;
    const norm = (s: string) => s.replace(/\D/g, "");
    return norm(meta.accountNumber) !== norm(account.accountNumber);
  }, [meta.accountNumber, account?.accountNumber]);

  function columnValues(col: string) {
    const i = asIndex(col);
    return i < 0 ? [] : bodyRows.map((r) => String(r[i] ?? ""));
  }

  useEffect(() => {
    if (asIndex(mapping.date) < 0 || !bodyRows.length) return;
    const formats = detectDateFormats(columnValues(mapping.date));
    setDateAmbiguous(formats.length !== 1);
    if (formats.length >= 1) setDateFormat(formats[0]!);
  }, [mapping.date, bodyRows]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cols = mapping.amountType === "signed"
      ? [mapping.amount]
      : [mapping.creditColumn, mapping.debitColumn];
    const samples = cols.flatMap(columnValues).filter(Boolean);
    if (!samples.length) return;
    const style = detectDecimalStyle(samples);
    if (style !== "ambiguous") setDecimalStyle(style);
  }, [mapping.amount, mapping.creditColumn, mapping.debitColumn, mapping.amountType, bodyRows]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Guess a column by what its heading says. Position is what gets stored. */
  function guessColumn(cells: string[], words: string[]): string {
    const i = cells.findIndex((h) => {
      const t = String(h ?? "").toLowerCase();
      return t && words.some((w) => t.includes(w));
    });
    return i >= 0 ? String(i) : NONE;
  }

  function loadSheet(rows: string[][], name: string) {
    if (rows.length < 2) {
      toast.error("That file has no rows in it");
      return;
    }
    const shape = detectHeaderRow(rows);
    const hr = shape.headerRow >= 0 ? shape.headerRow : 0;
    if (shape.headerRow < 0) {
      toast.error("Could not find a heading row — pick it below");
    }
    setSheet(rows);
    setHeaderRow(hr);
    setFileName(name);
    setMeta(readStatementMeta(rows.slice(0, hr)));

    const cells = (rows[hr] ?? []).map((c) => String(c ?? ""));
    const body = rows.slice(hr + 1);
    const credit = guessColumn(cells, ["deposit", "credit"]);
    const debit = guessColumn(cells, ["withdrawal", "debit"]);
    setMapping({
      date: guessColumn(cells, ["date"]),
      description: guessColumn(cells, ["particular", "narration", "description", "detail", "remark"]),
      amount: guessColumn(cells, ["amount", "value"]),
      reference: guessColumn(cells, ["cheque", "chq", "reference"]),
      externalId: guessColumn(cells, ["tran id", "transaction id", "txn id", "utr"]),
      balance: guessColumn(cells, ["balance"]),
      // A sheet with both a withdrawals and a deposits column is telling you
      // which it is; a single signed column is the other convention.
      amountType: credit !== NONE && debit !== NONE ? "separate" : "signed",
      creditColumn: credit,
      debitColumn: debit,
    });
    void body;
    setStep("map");
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setReading(true);
    try {
      const isSpreadsheet = /\.(xls|xlsx|xlsm|xlsb|ods)$/i.test(file.name);
      if (isSpreadsheet) {
        // Loaded on demand: the parser is large, and most of the app never
        // touches it.
        const XLSX = await import("xlsx");
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const first = wb.Sheets[wb.SheetNames[0]!];
        if (!first) {
          toast.error("That workbook has no sheets");
          return;
        }
        // `raw: false` keeps the bank's own formatting — a date the sheet shows
        // as 17/08/2026 stays that way instead of becoming a serial number.
        const rows = XLSX.utils.sheet_to_json<string[]>(first, { header: 1, raw: false, defval: "" });
        loadSheet(rows.map((r) => (r ?? []).map((c) => String(c ?? ""))), file.name);
      } else {
        const text = await file.text();
        loadSheet(parseDelimited(text, detectDelimiter(text)), file.name);
      }
    } catch {
      toast.error("Could not read that file");
    } finally {
      setReading(false);
      // Let the same file be chosen again after a failure.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function goToPreview() {
    if (good.length === 0) {
      toast.error("No rows could be read with this mapping");
      return;
    }
    try {
      const res = await preview.mutateAsync({
        transactions: good.map((r) => ({
          date: r.isoDate, description: r.description, amountMinor: r.amountMinor,
          reference: r.reference, externalId: r.externalId || undefined, notes: "",
        })),
      });
      setDuplicates(new Set(res.duplicates));
    } catch {
      setDuplicates(new Set());
      toast.error("Could not check for duplicates — the import will still skip them");
    }
    setStep("preview");
  }

  async function handleImport() {
    try {
      const transactions: ImportedTransactionInput[] = good.map((r) => ({
        date: r.isoDate, description: r.description, amountMinor: r.amountMinor,
        reference: r.reference, externalId: r.externalId || undefined, notes: "",
      }));
      const res = await bulkImport.mutateAsync({
        transactions, importBatchId: `import-${Date.now()}`, onDuplicate,
      });
      setResult({ count: res.count, skipped: res.skipped });
      setStep("done");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Import failed");
    }
  }

  function reset() {
    setStep("upload"); setSheet([]); setHeaderRow(0); setFileName("");
    setDuplicates(new Set()); setResult(null); setMeta({}); setMapping(EMPTY_MAPPING);
  }

  const mappingComplete =
    asIndex(mapping.date) >= 0 && asIndex(mapping.description) >= 0 &&
    (mapping.amountType === "signed"
      ? asIndex(mapping.amount) >= 0
      : asIndex(mapping.creditColumn) >= 0 && asIndex(mapping.debitColumn) >= 0);

  const money = (m: number) => `${m < 0 ? "−" : ""}${Math.abs(m / 100).toFixed(2)}`;

  /** A dropdown over the columns that actually hold something. */
  const ColumnSelect = ({
    value, onChange, optional = false, placeholder = "Select column",
  }: {
    value: string; onChange: (v: string) => void; optional?: boolean; placeholder?: string;
  }) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {optional && <SelectItem value={NONE}>None</SelectItem>}
        {columns.map((c) => (
          <SelectItem key={c.index} value={String(c.index)}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

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
              Excel (.xls, .xlsx) or CSV, straight from your bank. Account details above the
              transactions are read and skipped, and you confirm the date and number format
              before anything is imported.
            </p>
          </div>
          <Button onClick={() => fileRef.current?.click()} disabled={reading}>
            <FileText className="h-4 w-4" /> {reading ? "Reading…" : "Choose file"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,.tsv,.xls,.xlsx,.xlsm,.xlsb,.ods"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      )}

      {step === "map" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4">
            <FileText className="h-5 w-5 shrink-0 text-foreground-muted" />
            <span className="text-sm font-medium">{fileName}</span>
            <span className="text-xs text-foreground-muted">
              {bodyRows.length} rows · headings on row {headerRow + 1}
              {meta.accountNumber ? ` · account ${meta.accountNumber}` : ""}
            </span>
            <button onClick={reset} className="ml-auto text-foreground-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          {wrongAccount && (
            <div className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/5 p-4">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
              <div className="text-sm">
                <p className="font-medium">This statement is for a different account</p>
                <p className="mt-1 text-foreground-muted">
                  The file says <span className="font-mono">{meta.accountNumber}</span>, but{" "}
                  {account?.accountName} is <span className="font-mono">{account?.accountNumber}</span>.
                  Importing it here would put one account&rsquo;s transactions on another.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-4 rounded-lg border border-border bg-surface p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground-muted">
                Map Columns
              </h2>
              <div className="flex items-center gap-2">
                <Label className="text-xs text-foreground-muted">Heading row</Label>
                <Select value={String(headerRow)} onValueChange={(v) => setHeaderRow(Number(v))}>
                  <SelectTrigger className="h-8 w-[110px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {sheet.slice(0, 40).map((_, i) => (
                      <SelectItem key={i} value={String(i)}>Row {i + 1}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Date column *</Label>
                <ColumnSelect value={mapping.date} onChange={(v) => setMapping((m) => ({ ...m, date: v }))} />
              </div>
              <div className="space-y-1">
                <Label>Description column *</Label>
                <ColumnSelect value={mapping.description} onChange={(v) => setMapping((m) => ({ ...m, description: v }))} />
              </div>
              <div className="space-y-1">
                <Label>Reference / cheque (optional)</Label>
                <ColumnSelect optional value={mapping.reference} onChange={(v) => setMapping((m) => ({ ...m, reference: v }))} />
              </div>
              <div className="space-y-1">
                <Label>Bank transaction ID (optional)</Label>
                <ColumnSelect optional value={mapping.externalId} onChange={(v) => setMapping((m) => ({ ...m, externalId: v }))} />
                <p className="text-xs text-foreground-muted">
                  Unique per transaction, so a re-import is recognised exactly.
                </p>
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
                    <SelectItem value="separate">Separate withdrawals/deposits</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Balance column (optional)</Label>
                <ColumnSelect optional value={mapping.balance} onChange={(v) => setMapping((m) => ({ ...m, balance: v }))} />
                <p className="text-xs text-foreground-muted">
                  Checks the import against the bank&rsquo;s own running balance.
                </p>
              </div>

              {mapping.amountType === "signed" ? (
                <div className="space-y-1">
                  <Label>Amount column *</Label>
                  <ColumnSelect value={mapping.amount} onChange={(v) => setMapping((m) => ({ ...m, amount: v }))} />
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label>Deposits (money in) *</Label>
                    <ColumnSelect value={mapping.creditColumn} onChange={(v) => setMapping((m) => ({ ...m, creditColumn: v }))} />
                  </div>
                  <div className="space-y-1">
                    <Label>Withdrawals (money out) *</Label>
                    <ColumnSelect value={mapping.debitColumn} onChange={(v) => setMapping((m) => ({ ...m, debitColumn: v }))} />
                  </div>
                </>
              )}
            </div>
          </div>

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
                {asIndex(mapping.date) >= 0 && (
                  <p className={`text-xs ${dateAmbiguous ? "text-warning" : "text-foreground-muted"}`}>
                    {dateAmbiguous
                      ? "Every day in this file is 12 or under, so the order cannot be told from the file. Check the first row below."
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

            {mappingComplete && parsed[0] && (
              <div className="rounded-md border border-border bg-surface-muted/40 p-3 text-sm">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  First row reads as
                </p>
                {parsed[0].problems.length > 0 ? (
                  <p className="text-danger">{parsed[0].problems.join(" · ")}</p>
                ) : (
                  <p className="font-mono text-xs">
                    {parsed[0].isoDate} · {parsed[0].description.slice(0, 40)} ·{" "}
                    <span className={parsed[0].amountMinor >= 0 ? "text-success" : "text-danger"}>
                      {parsed[0].amountMinor >= 0 ? "+" : ""}{money(parsed[0].amountMinor)}
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

          {/* The strongest check available: the bank states a balance after
              every line, so a misread column shows up here rather than in a
              reconciliation three months from now. */}
          {balanceCheck && (
            <div
              className={`rounded-lg border p-4 ${
                balanceCheck.ok ? "border-success/40 bg-success/5" : "border-danger/40 bg-danger/5"
              }`}
            >
              {balanceCheck.ok ? (
                <p className="text-sm">
                  <span className="font-medium">Balances agree.</span>{" "}
                  <span className="text-foreground-muted">
                    Every line matches the bank&rsquo;s own running balance, ending at{" "}
                    {money(balanceCheck.expectedMinor)}.
                  </span>
                </p>
              ) : (
                <div className="text-sm">
                  <p className="font-medium">
                    The running balance stops matching at row {balanceCheck.firstMismatchAt + 1}
                  </p>
                  <p className="mt-1 text-foreground-muted">
                    The arithmetic gives {money(balanceCheck.expectedMinor)}, the bank says{" "}
                    {money(balanceCheck.statedMinor)}. Usually the withdrawals and deposits
                    columns are the wrong way round, or a row was left out.
                  </p>
                </div>
              )}
            </div>
          )}

          {duplicates.size > 0 && (
            <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-4">
              <p className="text-sm font-medium">{duplicates.size} of these are already on the account</p>
              <p className="text-xs text-foreground-muted">
                {asIndex(mapping.externalId) >= 0
                  ? "Matched on the bank's own transaction ID, so these are the same transactions, not merely similar ones. They will be left out."
                  : "Matched on date, amount, description and reference. Two genuinely separate payments of the same amount on the same day look identical here, so if that is what these are, import them."}
              </p>
              {asIndex(mapping.externalId) < 0 && (
                <Select value={onDuplicate} onValueChange={(v) => setOnDuplicate(v as "skip" | "import")}>
                  <SelectTrigger className="w-[280px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">Leave the {duplicates.size} out</SelectItem>
                    <SelectItem value="import">Import them, marked as duplicates</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {bad > 0 && (
            <div className="rounded-lg border border-danger/40 bg-danger/5 p-4">
              <p className="mb-2 text-sm font-medium">{bad} row{bad === 1 ? "" : "s"} could not be read</p>
              <ul className="space-y-1 text-xs text-foreground-muted">
                {parsed
                  .map((r, i) => ({ r, i }))
                  .filter(({ r }) => !r.blank && r.problems.length > 0)
                  .slice(0, 5)
                  .map(({ r, i }) => (
                    <li key={i}>Row {headerRow + i + 2}: {r.problems.join(" · ")}</li>
                  ))}
                {bad > 5 && <li>…and {bad - 5} more</li>}
              </ul>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <div className="max-h-[480px] overflow-x-auto overflow-y-auto">
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
                        <td className="px-4 py-2.5 text-xs text-foreground-muted">
                          {row.externalId || row.reference}
                        </td>
                        <td
                          className={`px-4 py-2.5 text-right font-mono font-medium ${
                            row.amountMinor >= 0 ? "text-success" : "text-danger"
                          }`}
                        >
                          {row.amountMinor >= 0 ? "+" : ""}{money(row.amountMinor)}
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
