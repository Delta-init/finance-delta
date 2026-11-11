"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Download, Upload } from "lucide-react";
import {
  checkManualPayrollRows, detectDelimiter, findManualPayrollHeaderRow, manualDeductionKey,
  manualPayrollLineSchema, manualPayrollTemplateRows, matchManualPayrollColumns, parseDelimited, parsePayrollAmount,
  readManualPayrollRows, MANUAL_DEDUCTIONS, MANUAL_PAYROLL_FIELDS,
  type ManualDeductionKey, type ManualPayrollColumns, type ManualPayrollField, type ManualPayrollLine,
} from "@delta/shared";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { useFileDrop } from "@/components/ui/file-drop";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAddManualLines, useCreateManualRun, useUpdateManualLine } from "./api";
import type { ManualRowProblem, RunLine } from "./types";

/*
 * Manual payroll (the user, 2026-11-11: "In Payroll section there is no option to create or import data, still blank
 * page shows"): an organization not run through HRMS makes its months here — a month per currency — and puts its people
 * on them, typed one at a time or imported from an Excel / CSV sheet. The rules for a person's line are @delta/shared's
 * (manual-payroll.ts), so what the preview here says about a row is what the API does with it.
 */

const FIELD =
  "h-9 w-full rounded-md border border-border bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30";

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const validMonth = (p: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p);
const validCurrency = (c: string) => /^[A-Za-z]{3}$/.test(c.trim());
const errorText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);

// ── New month ────────────────────────────────────────────────────────────────

/** A month, empty, in a currency (the organization's by default). Opens it once made. */
export function NewMonthDialog({
  open, onOpenChange, baseCurrency,
}: { open: boolean; onOpenChange: (o: boolean) => void; baseCurrency: string }) {
  const router = useRouter();
  const create = useCreateManualRun();
  const [period, setPeriod] = useState(thisMonth());
  const [currency, setCurrency] = useState(baseCurrency);
  useEffect(() => {
    if (open) { setPeriod(thisMonth()); setCurrency(baseCurrency); create.reset(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, baseCurrency]);

  const ok = validMonth(period) && validCurrency(currency);
  const submit = () =>
    ok && create.mutate({ period, currency: currency.trim().toUpperCase() }, {
      onSuccess: (r) => {
        toast.success(`${r.runNumber} made — add its people`);
        onOpenChange(false);
        router.push(`/payroll/runs/${r.id}`);
      },
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New payroll month</DialogTitle>
          <DialogDescription>
            One month per currency. Add its people next — one at a time, or import a sheet — then approve and pay it.
          </DialogDescription>
        </DialogHeader>
        <MonthFields period={period} setPeriod={setPeriod} currency={currency} setCurrency={setCurrency} />
        {create.isError && <p className="text-sm text-danger">{errorText(create.error, "Could not make the month")}</p>}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={create.isPending} disabled={!ok} onClick={submit}>Create month</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MonthFields({
  period, setPeriod, currency, setCurrency,
}: { period: string; setPeriod: (v: string) => void; currency: string; setCurrency: (v: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label htmlFor="payroll-month">Month</Label>
        <Input id="payroll-month" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="payroll-currency">Currency</Label>
        <Input
          id="payroll-currency" value={currency} maxLength={3} className="uppercase"
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
        />
      </div>
    </div>
  );
}

// ── Import ───────────────────────────────────────────────────────────────────

/** The template, to download: CSV, or Excel with the amounts as numbers and the codes as text. */
async function downloadTemplate(kind: "csv" | "xlsx", currency: string) {
  const heads = MANUAL_PAYROLL_FIELDS.map((f) => f.label);
  const rows = manualPayrollTemplateRows(currency);
  if (kind === "csv") {
    const cell = (c: string) => (/[,"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
    const text = [heads, ...rows].map((r) => r.map(cell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: "payroll-template.csv" }).click();
    URL.revokeObjectURL(url);
    return;
  }
  const XLSX = await import("xlsx");
  const firstAmount = MANUAL_PAYROLL_FIELDS.findIndex((f) => f.key === "gross");
  const body = rows.map((r) => r.map((c, i) => (i >= firstAmount ? Number(c.replace(/,/g, "")) : c)));
  const ws = XLSX.utils.aoa_to_sheet([heads, ...body]);
  ws["!cols"] = heads.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Payroll");
  XLSX.writeFile(wb, "payroll-template.xlsx");
}

/** The file's rows: Excel as Excel holds them (amounts as numbers), CSV as text. */
async function readSheet(file: File): Promise<unknown[][]> {
  if (/\.(xls|xlsx|xlsm|xlsb|ods)$/i.test(file.name)) {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", dateNF: "yyyy-mm-dd" });
    const first = wb.Sheets[wb.SheetNames[0]!];
    if (!first) throw new Error("That workbook has no sheets");
    return XLSX.utils.sheet_to_json<unknown[]>(first, { header: 1, raw: true, defval: "" });
  }
  const text = await file.text();
  return parseDelimited(text, detectDelimiter(text));
}

type PreviewRow = { rowNo: number; line: ManualPayrollLine | null; name: string; problems: string[]; netMinor: number | null; deductionsMinor: number | null };

/**
 * Import a sheet — into a new month (`into` absent: the month and currency asked here) or one already open. Upload,
 * match the columns (found by their headings; changeable), see every row with what is wrong with it and the totals,
 * then create: the good rows go on, the others are left out and listed.
 */
export function ImportPayrollDialog({
  open, onOpenChange, baseCurrency, into,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  baseCurrency: string;
  /** An open month to add to. */
  into?: { id: string; runNumber: string; period: string; currency: string; codes: string[] };
}) {
  const router = useRouter();
  const create = useCreateManualRun();
  const add = useAddManualLines(into?.id ?? "");
  const [period, setPeriod] = useState(thisMonth());
  const [currency, setCurrency] = useState(baseCurrency);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<unknown[][] | null>(null);
  const [headerRow, setHeaderRow] = useState(0);
  const [columns, setColumns] = useState<ManualPayrollColumns>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [done, setDone] = useState<{ runId: string; runNumber: string; created: number; problems: ManualRowProblem[] } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setPeriod(thisMonth()); setCurrency(into?.currency ?? baseCurrency);
    setFileName(""); setRows(null); setHeaderRow(0); setColumns({}); setNotice(null); setDone(null);
    create.reset(); add.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const monthCurrency = (into?.currency ?? currency).trim().toUpperCase();

  async function onFile(file: File) {
    setReading(true); setNotice(null); setDone(null);
    try {
      const got = await readSheet(file);
      if (!got.length) throw new Error("That file is empty");
      let hr = findManualPayrollHeaderRow(got);
      if (hr < 0) {
        hr = got.findIndex((r) => r.some((c) => String(c ?? "").trim()));
        setNotice("No heading row with a Name and a Gross pay column was found — the first row is used as headings. Match the columns below, or use the template.");
      }
      const cols = matchManualPayrollColumns(got[hr] ?? []);
      setRows(got); setHeaderRow(hr); setColumns(cols); setFileName(file.name);
      // A new month takes the sheet's currency when every row names the same one.
      if (!into && cols.currency !== undefined) {
        const named = new Set(got.slice(hr + 1).map((r) => String(r[cols.currency!] ?? "").trim().toUpperCase()).filter(Boolean));
        if (named.size === 1) { const only = [...named][0]!; if (validCurrency(only)) setCurrency(only); }
      }
    } catch (e) {
      setRows(null);
      setNotice(errorText(e, "That file couldn't be read"));
    } finally {
      setReading(false);
    }
  }
  const drop = useFileDrop({
    onFiles: ([f]) => { if (f) void onFile(f); },
    accept: ".csv,.xlsx,.xls,.xlsm,.ods,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel",
    disabled: reading,
  });

  const headings = useMemo(() => (rows?.[headerRow] ?? []).map((c, i) => String(c ?? "").trim() || `Column ${i + 1}`), [rows, headerRow]);
  const missingRequired = MANUAL_PAYROLL_FIELDS.filter((f) => f.required && columns[f.key] === undefined);

  const preview = useMemo(() => {
    if (!rows || missingRequired.length) return null;
    const read = readManualPayrollRows(rows, headerRow, columns);
    const checked = checkManualPayrollRows(read.lines, monthCurrency, into?.codes ?? []);
    const list: PreviewRow[] = [
      ...checked.rows.map((r) => ({
        rowNo: r.rowNo, line: r.line, name: r.line.name, problems: r.check.problems,
        netMinor: r.check.netMinor, deductionsMinor: r.check.deductionsMinor,
      })),
      ...read.unreadable.map((u) => ({ rowNo: u.rowNo, line: null, name: u.name, problems: u.problems, netMinor: null, deductionsMinor: null })),
    ].sort((a, b) => a.rowNo - b.rowNo);
    return { read, checked, list, bad: checked.bad + read.unreadable.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, headerRow, columns, monthCurrency, into?.codes, missingRequired.length]);

  const tooMany = (preview?.read.lines.length ?? 0) > 1000;
  const monthOk = into ? true : validMonth(period) && validCurrency(currency);
  const canSubmit = Boolean(preview && preview.checked.good > 0 && monthOk && !tooMany);
  const pending = create.isPending || add.isPending;
  const failed = create.error ?? add.error;

  function submit() {
    if (!preview || !canSubmit) return;
    const lines = preview.read.lines;
    if (into) {
      add.mutate({ lines, partial: true }, {
        onSuccess: (r) => {
          toast.success(r.message);
          setDone({ runId: into.id, runNumber: into.runNumber, created: r.created ?? 0, problems: r.problems ?? [] });
        },
      });
    } else {
      create.mutate({ period, currency: monthCurrency, lines }, {
        onSuccess: (r) => {
          toast.success(`${r.runNumber} made with ${r.created} ${r.created === 1 ? "person" : "people"}`);
          setDone({ runId: r.id, runNumber: r.runNumber, created: r.created, problems: r.problems });
        },
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{into ? `Import people into ${into.runNumber}` : "Import a payroll month"}</DialogTitle>
          <DialogDescription>
            {into
              ? `${into.period} · ${into.currency}. Rows already on the month (by employee code) are left out.`
              : "From Excel or CSV: one row per person — name and gross pay, with PF, ESI, professional tax, TDS and other deductions. Net is worked out; a Net column, if there is one, must agree."}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="space-y-3 text-sm">
            <p className="flex items-start gap-2 font-medium text-success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              {done.created} {done.created === 1 ? "person" : "people"} added to {done.runNumber}.
            </p>
            {done.problems.length > 0 && <ProblemList problems={done.problems} title="Left out" />}
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            {!into && <MonthFields period={period} setPeriod={setPeriod} currency={currency} setCurrency={setCurrency} />}

            <div className="relative rounded-lg border border-dashed border-border p-4" {...drop.zoneProps}>
              {drop.overlay}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={picker} type="file" className="hidden"
                  accept=".csv,.xlsx,.xls,.xlsm,.ods"
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onFile(f); }}
                />
                <Button size="sm" variant="secondary" loading={reading} onClick={() => picker.current?.click()}>
                  <Upload className="mr-1.5 h-3.5 w-3.5" />{rows ? "Choose another file" : "Choose a file"}
                </Button>
                {fileName && <span className="text-foreground-muted">{fileName}</span>}
                <span className="ml-auto flex items-center gap-1 text-xs text-foreground-muted">
                  Template:
                  <Button size="sm" variant="ghost" onClick={() => void downloadTemplate("xlsx", monthCurrency || baseCurrency)}>
                    <Download className="mr-1 h-3.5 w-3.5" />Excel
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void downloadTemplate("csv", monthCurrency || baseCurrency)}>
                    <Download className="mr-1 h-3.5 w-3.5" />CSV
                  </Button>
                </span>
              </div>
              <div className="mt-2">{drop.hint}</div>
            </div>

            {notice && (
              <p className="flex items-start gap-2 text-warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{notice}</span></p>
            )}

            {rows && (
              <div className="space-y-2">
                <p className="font-medium">Match the columns</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {MANUAL_PAYROLL_FIELDS.map((f) => (
                    <label key={f.key} className="space-y-1">
                      <span className="text-xs text-foreground-muted">{f.label}{f.required ? " *" : ""}</span>
                      <select
                        className={FIELD}
                        value={columns[f.key] ?? ""}
                        onChange={(e) => setColumns((c) => {
                          const next = { ...c };
                          if (e.target.value === "") delete next[f.key as ManualPayrollField];
                          else next[f.key as ManualPayrollField] = Number(e.target.value);
                          return next;
                        })}
                      >
                        <option value="">— not in the file —</option>
                        {headings.map((h, i) => <option key={i} value={i}>{h}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                {missingRequired.length > 0 && (
                  <p className="text-danger">Choose the column for {missingRequired.map((f) => f.label).join(" and ")}.</p>
                )}
              </div>
            )}

            {preview && (
              <div className="space-y-2">
                <p className="font-medium">
                  {preview.checked.good} {preview.checked.good === 1 ? "row" : "rows"} ready
                  {preview.bad > 0 && <span className="text-danger"> · {preview.bad} with problems — left out</span>}
                  {preview.read.skipped > 0 && <span className="font-normal text-foreground-muted"> · {preview.read.skipped} blank or total row(s) passed over</span>}
                </p>
                {tooMany && <p className="text-danger">At most 1,000 rows at a time — split the sheet.</p>}
                {preview.checked.byCurrency.length > 0 && (
                  <table className="w-full max-w-xl text-xs">
                    <thead className="text-left text-foreground-muted">
                      <tr><th className="py-1">Currency</th><th>People</th><th className="text-right">Gross</th><th className="text-right">Deductions</th><th className="text-right">Net</th></tr>
                    </thead>
                    <tbody>
                      {preview.checked.byCurrency.map((c) => (
                        <tr key={c.currency} className="border-t border-border">
                          <td className="py-1 font-mono">{c.currency}</td>
                          <td>{c.employeeCount}</td>
                          <td className="text-right"><MoneyDisplay minor={c.grossMinor} currency={c.currency} /></td>
                          <td className="text-right"><MoneyDisplay minor={c.deductionsMinor} currency={c.currency} /></td>
                          <td className="text-right font-semibold"><MoneyDisplay minor={c.netMinor} currency={c.currency} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="max-h-72 overflow-auto rounded-md border border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-surface text-left text-foreground-muted">
                      <tr>
                        <th className="px-2 py-1.5">Row</th><th className="px-2">Code</th><th className="px-2">Name</th>
                        <th className="px-2 text-right">Gross</th><th className="px-2 text-right">Deductions</th>
                        <th className="px-2 text-right">Net</th><th className="px-2">Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.list.slice(0, 500).map((r) => (
                        <tr key={r.rowNo} className={`border-t border-border ${r.problems.length ? "bg-danger/5" : ""}`}>
                          <td className="px-2 py-1 tabular-nums text-foreground-muted">{r.rowNo}</td>
                          <td className="px-2">{r.line?.employeeCode}</td>
                          <td className="px-2">{r.name || <span className="text-foreground-muted">—</span>}</td>
                          <td className="px-2 text-right tabular-nums">{r.line ? <MoneyDisplay minor={r.line.grossMinor} currency={monthCurrency} /> : ""}</td>
                          <td className="px-2 text-right tabular-nums">{r.deductionsMinor !== null ? <MoneyDisplay minor={r.deductionsMinor} currency={monthCurrency} /> : ""}</td>
                          <td className="px-2 text-right tabular-nums">{r.netMinor !== null ? <MoneyDisplay minor={r.netMinor} currency={monthCurrency} /> : ""}</td>
                          <td className="px-2">
                            {r.problems.length
                              ? <span className="text-danger">{r.problems.join("; ")}</span>
                              : <span className="text-success">OK</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.list.length > 500 && <p className="px-2 py-1 text-xs text-foreground-muted">…and {preview.list.length - 500} more rows</p>}
                </div>
              </div>
            )}

            {failed && <FailedList error={failed} />}
          </div>
        )}

        <DialogFooter>
          {done ? (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button>
              {!into && (
                <Button onClick={() => { onOpenChange(false); router.push(`/payroll/runs/${done.runId}`); }}>
                  Open {done.runNumber}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button loading={pending} disabled={!canSubmit} onClick={submit}>
                {into
                  ? `Add ${preview?.checked.good ?? 0} ${preview?.checked.good === 1 ? "person" : "people"}`
                  : `Create ${validMonth(period) ? period : "month"} with ${preview?.checked.good ?? 0} ${preview?.checked.good === 1 ? "person" : "people"}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProblemList({ problems, title }: { problems: ManualRowProblem[]; title: string }) {
  return (
    <div className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-xs">
      <p className="mb-1 font-medium text-danger">{title}: {problems.length} row(s)</p>
      <ul className="max-h-48 space-y-0.5 overflow-auto">
        {problems.map((p) => (
          <li key={p.rowNo}>Row {p.rowNo}{p.name ? ` · ${p.name}` : ""}: {p.problems.join("; ")}</li>
        ))}
      </ul>
    </div>
  );
}

/** The API's refusal, with its rows when it sent them. */
function FailedList({ error }: { error: unknown }) {
  const rows = error instanceof ApiError ? (error.details as { problems?: ManualRowProblem[] } | undefined)?.problems : undefined;
  return rows?.length
    ? <ProblemList problems={rows} title={errorText(error, "Refused")} />
    : <p className="text-danger">{errorText(error, "Something went wrong")}</p>;
}

// ── One person ───────────────────────────────────────────────────────────────

type Draft = {
  employeeCode: string; name: string; departmentName: string; designation: string;
  bankName: string; accountNumber: string; ifsc: string; gross: string;
} & Record<ManualDeductionKey, string>;

const amountText = (minor: number) => (minor ? (minor / 100).toFixed(2) : "");

function draftOf(line: RunLine | null): Draft {
  const d: Record<ManualDeductionKey, string> = { pf: "", esi: "", professionalTax: "", tds: "", other: "" };
  for (const x of line?.deductions ?? []) {
    const key = manualDeductionKey(x.label) ?? "other";
    d[key] = amountText(parsePayrollAmountMinor(d[key]) + x.amountMinor);
  }
  return {
    employeeCode: line?.employeeCode ?? "", name: line?.name ?? "", departmentName: line?.departmentName ?? "",
    designation: line?.designation ?? "", bankName: line?.bank.bankName ?? "", accountNumber: line?.bank.accountNumber ?? "",
    ifsc: line?.bank.ifsc ?? "", gross: line ? amountText(line.grossMinor) : "", ...d,
  };
}
function parsePayrollAmountMinor(text: string): number {
  const r = parsePayrollAmount(text);
  return r.ok ? r.minor ?? 0 : 0;
}

/** Add one person to an open month, or change one already on it. Net is worked out as it is typed. */
export function LineDialog({
  open, onOpenChange, runId, currency, line, codes,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  runId: string;
  currency: string;
  /** Who is being changed; null to add somebody. */
  line: RunLine | null;
  /** The employee codes already on the month. */
  codes: string[];
}) {
  const add = useAddManualLines(runId);
  const update = useUpdateManualLine(runId);
  const [draft, setDraft] = useState<Draft>(draftOf(line));
  useEffect(() => {
    if (open) { setDraft(draftOf(line)); add.reset(); update.reset(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, line]);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  // Each amount read as the import reads it; one that isn't an amount is said so.
  const unreadable: string[] = [];
  const amount = (label: string, text: string) => {
    const r = parsePayrollAmount(text);
    if (!r.ok) { unreadable.push(`${label}: ${r.reason}`); return 0; }
    return r.minor ?? 0;
  };
  const parsed = manualPayrollLineSchema.safeParse({
    employeeCode: draft.employeeCode, name: draft.name, departmentName: draft.departmentName, designation: draft.designation,
    bankName: draft.bankName, accountNumber: draft.accountNumber, ifsc: draft.ifsc,
    grossMinor: amount("Gross pay", draft.gross),
    deductions: Object.fromEntries(MANUAL_DEDUCTIONS.map((d) => [d.key, amount(d.label, draft[d.key])])),
  });
  // Only an absurd amount fails to parse (the inputs cap every text): checked as nothing, and said.
  const input = parsed.success ? parsed.data : manualPayrollLineSchema.parse({ name: draft.name.slice(0, 120), grossMinor: 0 });
  if (!parsed.success) unreadable.push("An amount is too large to be pay");
  const others = codes.filter((c) => !line || c.trim().toLowerCase() !== line.employeeCode.trim().toLowerCase());
  const check = checkManualPayrollRows([input], currency, others).rows[0]!.check;
  const touched = Boolean(draft.name || draft.gross);
  const problems = [...unreadable, ...check.problems];
  const pending = add.isPending || update.isPending;
  const failed = add.error ?? update.error;

  const submit = () => {
    if (problems.length) return;
    const done = { onSuccess: () => { toast.success(line ? `${input.name} updated` : `${input.name} added`); onOpenChange(false); } };
    if (line) update.mutate({ lineId: line.id, line: input }, done);
    else add.mutate({ lines: [input] }, done);
  };

  const text = (k: keyof Draft, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`line-${k}`} className="text-xs">{label}</Label>
      <Input id={`line-${k}`} value={draft[k]} onChange={set(k)} {...extra} />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{line ? `Change ${line.name}` : "Add a person"}</DialogTitle>
          <DialogDescription>Amounts in {currency}. Net pay is gross less the deductions.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {text("name", "Name *", { autoFocus: true, maxLength: 120 })}
          {text("employeeCode", "Employee code", { maxLength: 40 })}
          {text("departmentName", "Department", { maxLength: 120 })}
          {text("designation", "Designation", { maxLength: 120 })}
          {text("bankName", "Bank name", { maxLength: 120 })}
          {text("accountNumber", "Account number", { maxLength: 40 })}
          {text("ifsc", "IFSC", { maxLength: 20 })}
          {text("gross", "Gross pay *", { inputMode: "decimal", placeholder: "45,000" })}
        </div>
        <div className="grid gap-3 sm:grid-cols-5">
          {MANUAL_DEDUCTIONS.map((d) => <div key={d.key}>{text(d.key, d.label, { inputMode: "decimal", placeholder: "0" })}</div>)}
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm">
          <span className="text-foreground-muted">
            Gross <MoneyDisplay minor={check.grossMinor} currency={currency} /> − deductions <MoneyDisplay minor={check.deductionsMinor} currency={currency} />
          </span>
          <span className="font-semibold">Net <MoneyDisplay minor={check.netMinor} currency={currency} /></span>
        </div>
        {touched && problems.length > 0 && (
          <ul className="space-y-0.5 text-sm text-danger">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        )}
        {failed && <FailedList error={failed} />}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={pending} disabled={problems.length > 0} onClick={submit}>{line ? "Save" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Confirm ──────────────────────────────────────────────────────────────────

/** Yes or no, for removing somebody or deleting a month. */
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, pending, onConfirm,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string;
  confirmLabel: string; pending?: boolean; onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" loading={pending} onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A manual line's named deductions, by key — for the run page's columns and export. */
export function manualParts(l: Pick<RunLine, "deductions">): Record<ManualDeductionKey, number> {
  const out: Record<ManualDeductionKey, number> = { pf: 0, esi: 0, professionalTax: 0, tds: 0, other: 0 };
  for (const d of l.deductions) out[manualDeductionKey(d.label) ?? "other"] += d.amountMinor;
  return out;
}
