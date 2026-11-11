"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle, ArrowLeft, CheckCircle2, Copy, Download, FileSpreadsheet, FileText, Upload, UserPlus, X, type LucideIcon,
} from "lucide-react";
import {
  IMPORT_CHUNK_ROWS,
  IMPORT_DATE_FORMAT_LABELS,
  IMPORT_MAX_ROWS,
  guessImportColumns,
  parseImportDate,
  type ImportDateFormat,
  type ImportField,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportResultRow,
  type Permission,
} from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFileDrop } from "@/components/ui/file-drop";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { useImportPreview, useImportRun, type ImportResource } from "./api";
import { IMPORT_ACCEPT, downloadTemplate, readSheet, type SheetRow } from "./read-sheet";

/*
 * Importing bills or expenses from a spreadsheet (the user, 2026-11-11): Upload → Match columns → Preview → Done,
 * after the bank statement import. The file is read here; the API checks every row (preview, nothing written) and then
 * makes the good ones through the same services as the forms. A large file goes in parts of IMPORT_CHUNK_ROWS, so no
 * request runs long; a part that fails stops the rest, and importing the file again skips what already went in.
 */

/** One column of the Preview table. */
export interface PreviewColumn {
  header: string;
  align?: "right";
  cell: (r: ImportPreviewRow) => ReactNode;
}

/** What is being imported. */
export interface ImportKind<K extends string = string> {
  resource: ImportResource;
  title: string;
  icon: LucideIcon;
  /** The list it is opened from, and goes back to. */
  backHref: string;
  backLabel: string;
  /** "expense", "expenses". */
  noun: [string, string];
  fields: readonly ImportField<K>[];
  /** The fields holding dates — the date format applies to them. */
  dateFields: readonly K[];
  templateName: string;
  permission: Permission;
  recordHref: (id: string) => string;
  columns: PreviewColumn[];
  /** Said under the column list on the Upload step. */
  notes: ReactNode;
}

const NONE = "__none__";
type Step = "upload" | "map" | "preview" | "done";
const STEPS: { key: Exclude<Step, "done">; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "map", label: "Match columns" },
  { key: "preview", label: "Preview" },
];

/** A day as "15 Jan 2026": a swapped day and month shows at a glance, which 03/01/2026 never does. */
export function fmtDay(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The heading row: of the first twenty, the one most of the fields' names match. */
function findHeader<K extends string>(rows: SheetRow[], fields: readonly ImportField<K>[]): number {
  let best = 0, score = 0;
  rows.slice(0, 20).forEach((r, i) => {
    const s = Object.keys(guessImportColumns(fields, r.cells)).length;
    if (s > score) { score = s; best = i; }
  });
  return best;
}

interface Outcome {
  batchId: string;
  created: ImportResultRow[];
  /** Skipped as repeats: in the preview, and any found while importing. */
  duplicates: number;
  errors: { row: number; message: string }[];
  warnings: ImportResultRow[];
  newVendors: { id: string; name: string }[];
  /** Why it stopped part way, and how many rows were not sent. */
  stopped?: { message: string; notSent: number };
}

export function ImportWizard<K extends string>({ kind }: { kind: ImportKind<K> }) {
  const router = useRouter();
  const { can, ready } = useCan();
  const preview = useImportPreview(kind.resource);
  const run = useImportRun(kind.resource);
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("upload");
  const [reading, setReading] = useState(false);
  const [fileName, setFileName] = useState("");
  const [sheet, setSheet] = useState<SheetRow[]>([]);
  const [headerAt, setHeaderAt] = useState(0);
  const [mapping, setMapping] = useState<Partial<Record<K, number>>>({});
  const [dateFormat, setDateFormat] = useState<ImportDateFormat>("dmy");
  const [checked, setChecked] = useState<ImportPreview | null>(null);
  const [filter, setFilter] = useState<"all" | "ok" | "duplicate" | "error">("all");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const [one, many] = kind.noun;
  const headings = useMemo(() => sheet[headerAt]?.cells ?? [], [sheet, headerAt]);
  const body = useMemo(() => sheet.slice(headerAt + 1), [sheet, headerAt]);
  const columns = useMemo(
    () => headings
      .map((h, i) => ({ index: i, label: h.trim() || `Column ${i + 1}`, named: !!h.trim() }))
      .filter((c) => c.named || body.some((r) => (r.cells[c.index] ?? "").trim() !== "")),
    [headings, body],
  );

  // The columns guessed again whenever the heading row moves.
  useEffect(() => {
    if (sheet.length) setMapping(guessImportColumns(kind.fields, headings));
  }, [sheet, headings, kind.fields]);

  const cellOf = (r: SheetRow, key: K) => {
    const i = mapping[key];
    return i === undefined || i < 0 ? "" : String(r.cells[i] ?? "");
  };

  /** The rows as the API takes them: every field's cell as text, rows with nothing in any matched column left out. */
  const rows = useMemo(() => body
    .filter((r) => kind.fields.some((f) => {
      const i = mapping[f.key];
      return i !== undefined && i >= 0 && String(r.cells[i] ?? "").trim() !== "";
    }))
    .map((r) => ({ row: r.n, ...Object.fromEntries(kind.fields.map((f) => [f.key, cellOf(r, f.key).slice(0, 4000)])) })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [body, mapping, kind.fields]);

  /* Dates written 03/04/2026 decide the format: day-first unless only month-first reads them all. */
  const dateNote = useMemo(() => {
    const values = body.flatMap((r) => kind.dateFields.map((k) => cellOf(r, k).trim())).filter(Boolean)
      .filter((v) => !/^\d{4}/.test(v) && !/[a-z]/i.test(v));
    if (!values.length) return null;
    const dmy = values.every((v) => parseImportDate(v, "dmy").ok);
    const mdy = values.every((v) => parseImportDate(v, "mdy").ok);
    return { dmy, mdy };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, mapping, kind.dateFields]);
  useEffect(() => {
    if (dateNote && !dateNote.dmy && dateNote.mdy) setDateFormat("mdy");
    else if (dateNote && dateNote.dmy && !dateNote.mdy) setDateFormat("dmy");
  }, [dateNote]);

  const missing = kind.fields.filter((f) => f.required && (mapping[f.key] === undefined || (mapping[f.key] as number) < 0));

  async function takeFile(file: File) {
    setReading(true);
    try {
      const read = await readSheet(file);
      if (read.length < 2) {
        toast.error("That file has no rows under its headings");
        return;
      }
      setSheet(read);
      setHeaderAt(findHeader(read, kind.fields));
      setFileName(file.name);
      setStep("map");
    } catch {
      toast.error("Could not read that file — is it a CSV or an Excel workbook?");
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  const drop = useFileDrop({
    onFiles: ([f]) => { if (f) void takeFile(f); },
    accept: IMPORT_ACCEPT,
    disabled: step !== "upload" || reading,
  });

  async function check() {
    if (!rows.length) return toast.error("No rows under the headings have anything in the matched columns");
    if (rows.length > IMPORT_MAX_ROWS) return toast.error(`${rows.length} rows — at most ${IMPORT_MAX_ROWS} at a time. Split the file.`);
    const req = { dateFormat, fileName: fileName.slice(0, 200), rows };
    if (JSON.stringify(req).length > 950_000) return toast.error("This file holds too much text to check at once — split it into smaller files");
    try {
      setChecked(await preview.mutateAsync(req));
      setFilter("all");
      setStep("preview");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not check the file");
    }
  }

  async function runImport() {
    if (!checked) return;
    const okRows = new Set(checked.rows.filter((r) => r.status === "ok").map((r) => r.row));
    const toSend = rows.filter((r) => okRows.has(r.row));
    const out: Outcome = {
      batchId: "", created: [], duplicates: checked.counts.duplicate, warnings: [], newVendors: [],
      errors: checked.rows.filter((r) => r.status === "error").map((r) => ({ row: r.row, message: r.message ?? "" })),
    };
    setProgress({ done: 0, total: toSend.length });
    let batchId: string | undefined;
    for (let i = 0; i < toSend.length; i += IMPORT_CHUNK_ROWS) {
      const part = toSend.slice(i, i + IMPORT_CHUNK_ROWS);
      try {
        const res = await run.mutateAsync({ dateFormat, fileName: fileName.slice(0, 200), rows: part, ...(batchId ? { batchId } : {}) });
        batchId = res.batchId;
        out.batchId = res.batchId;
        for (const r of res.rows) {
          if (r.status === "created") out.created.push(r);
          else if (r.status === "duplicate") out.duplicates += 1;
          else out.errors.push({ row: r.row, message: r.message ?? "" });
          if (r.warning) out.warnings.push(r);
        }
        out.newVendors.push(...res.newVendors);
        setProgress({ done: Math.min(i + part.length, toSend.length), total: toSend.length });
      } catch (e) {
        out.stopped = { message: e instanceof ApiError ? e.message : "The connection failed", notSent: toSend.length - i };
        break;
      }
    }
    out.errors.sort((a, b) => a.row - b.row);
    setOutcome(out);
    setProgress(null);
    setStep("done");
  }

  function reset() {
    setStep("upload"); setSheet([]); setHeaderAt(0); setFileName(""); setMapping({});
    setChecked(null); setOutcome(null); setProgress(null); setDateFormat("dmy");
  }

  if (ready && !can(kind.permission)) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <Header kind={kind} sub="" />
        <div className="rounded-lg border border-border bg-surface p-6 text-sm text-foreground-muted">
          You can&rsquo;t add {many}, so you can&rsquo;t import them either. Ask someone who can.
        </div>
      </div>
    );
  }

  const shown = checked?.rows.filter((r) => filter === "all" || r.status === filter) ?? [];
  const okCount = checked?.counts.ok ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <Header kind={kind} sub={fileName ? fileName : `From a CSV or Excel file — at most ${IMPORT_MAX_ROWS.toLocaleString()} rows`} />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {STEPS.map((s, i) => {
          const at = step === "done" ? STEPS.length : STEPS.findIndex((x) => x.key === step);
          return (
            <span key={s.key} className="flex items-center gap-2">
              {i > 0 && <span className="text-foreground-subtle">›</span>}
              <span className={at === i ? "font-semibold text-foreground" : at > i ? "text-success" : "text-foreground-muted"}>
                {i + 1}. {s.label}
              </span>
            </span>
          );
        })}
        <span className="flex items-center gap-2">
          <span className="text-foreground-subtle">›</span>
          <span className={step === "done" ? "font-semibold text-foreground" : "text-foreground-muted"}>4. Done</span>
        </span>
      </div>

      {step === "upload" && (
        <div className="space-y-4">
          <div className="relative flex flex-col items-center gap-4 rounded-lg border border-border bg-surface p-8 text-center" {...drop.zoneProps}>
            {drop.overlay}
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-muted">
              <Upload className="h-8 w-8 text-foreground-subtle" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">Upload a file of {many}</h2>
              <p className="mx-auto mt-1 max-w-lg text-sm text-foreground-muted">
                Excel (.xlsx, .xls) or CSV, one {one} per row under a row of headings. You match the columns and see every
                row checked before anything is saved.
              </p>
            </div>
            <Button onClick={() => fileRef.current?.click()} disabled={reading}>
              <FileText className="h-4 w-4" /> {reading ? "Reading…" : "Choose file"}
            </Button>
            <input ref={fileRef} type="file" accept={IMPORT_ACCEPT} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void takeFile(f); }} />
            <div className="space-y-1">{drop.hint}</div>
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-surface p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground-muted">Columns</h2>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void downloadTemplate(kind.fields, kind.templateName, "xlsx")}>
                  <Download className="h-4 w-4" /> Template (Excel)
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void downloadTemplate(kind.fields, kind.templateName, "csv")}>
                  <Download className="h-4 w-4" /> CSV
                </Button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {kind.fields.map((f) => (
                    <tr key={f.key} className="border-t border-border first:border-t-0">
                      <td className="whitespace-nowrap py-2 pr-4 font-medium">{f.label}{f.required ? <span className="text-danger"> *</span> : null}</td>
                      <td className="py-2 pr-4 text-foreground-muted">{f.hint ?? (f.required ? "Required" : "Optional")}</td>
                      <td className="whitespace-nowrap py-2 font-mono text-xs text-foreground-subtle">{f.example}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-foreground-muted">{kind.notes}</div>
          </div>
        </div>
      )}

      {step === "map" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4">
            <FileSpreadsheet className="h-5 w-5 shrink-0 text-foreground-muted" />
            <span className="text-sm font-medium">{fileName}</span>
            <span className="text-xs text-foreground-muted">{rows.length} row{rows.length === 1 ? "" : "s"} · headings on row {sheet[headerAt]?.n ?? 1}</span>
            <button onClick={reset} className="ml-auto text-foreground-muted hover:text-foreground" aria-label="Choose another file">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4 rounded-lg border border-border bg-surface p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground-muted">Match columns</h2>
              <div className="flex items-center gap-2">
                <Label className="text-xs text-foreground-muted">Heading row</Label>
                <Select value={String(headerAt)} onValueChange={(v) => setHeaderAt(Number(v))}>
                  <SelectTrigger className="h-8 w-[110px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {sheet.slice(0, 20).map((r, i) => <SelectItem key={i} value={String(i)}>Row {r.n}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {kind.fields.map((f) => (
                <div key={f.key} className="space-y-1">
                  <Label>{f.label}{f.required ? " *" : ""}</Label>
                  <Select
                    value={mapping[f.key] === undefined || (mapping[f.key] as number) < 0 ? NONE : String(mapping[f.key])}
                    onValueChange={(v) => setMapping((m) => ({ ...m, [f.key]: v === NONE ? -1 : Number(v) }))}
                  >
                    <SelectTrigger><SelectValue placeholder="Not in the file" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not in the file</SelectItem>
                      {columns.map((c) => <SelectItem key={c.index} value={String(c.index)}>{c.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {f.hint && <p className="text-xs text-foreground-muted">{f.hint}</p>}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-4 rounded-lg border border-border bg-surface p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground-muted">Dates</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Dates written like 03/04/2026 are</Label>
                <Select value={dateFormat} onValueChange={(v) => setDateFormat(v as ImportDateFormat)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(IMPORT_DATE_FORMAT_LABELS) as ImportDateFormat[]).map((f) => (
                      <SelectItem key={f} value={f}>{IMPORT_DATE_FORMAT_LABELS[f]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className={`text-xs ${dateNote && dateNote.dmy && dateNote.mdy ? "text-warning" : "text-foreground-muted"}`}>
                  {!dateNote
                    ? "Dates like 2026-01-15 or 15-Jan-2026, and real Excel dates, read the same either way."
                    : dateNote.dmy && dateNote.mdy
                      ? "Every day in this file is 12 or under, so the order can't be told from it — check the dates below."
                      : dateNote.dmy || dateNote.mdy
                        ? "Worked out from the file."
                        : "Some dates can't be read either way — those rows will show as errors."}
                </p>
              </div>
            </div>

            {missing.length === 0 && rows.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-border bg-surface-muted/40">
                <p className="px-3 pt-3 text-xs font-medium uppercase tracking-wide text-foreground-muted">The first rows read as</p>
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-foreground-muted">Row</th>
                      {kind.fields.filter((f) => (mapping[f.key] ?? -1) >= 0).map((f) => (
                        <th key={f.key} className="whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-muted">{f.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 3).map((r) => (
                      <tr key={r.row} className="border-t border-border">
                        <td className="px-3 py-2 text-foreground-muted">{r.row}</td>
                        {kind.fields.filter((f) => (mapping[f.key] ?? -1) >= 0).map((f) => {
                          const raw = String((r as Record<string, unknown>)[f.key] ?? "");
                          if (!(kind.dateFields as readonly string[]).includes(f.key) || !raw.trim()) {
                            return <td key={f.key} className="max-w-[220px] truncate px-3 py-2">{raw || "—"}</td>;
                          }
                          const d = parseImportDate(raw, dateFormat);
                          return (
                            <td key={f.key} className="whitespace-nowrap px-3 py-2">
                              {d.ok ? <span className="font-medium">{fmtDay(d.iso)}</span> : <span className="text-danger">{d.reason}</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {missing.length > 0 && (
              <span className="text-xs text-danger">Match {missing.map((f) => f.label).join(", ")} to a column</span>
            )}
            <Button variant="outline" onClick={reset}>Back</Button>
            <Button onClick={() => void check()} disabled={missing.length > 0 || preview.isPending}>
              {preview.isPending ? "Checking…" : "Check rows"}
            </Button>
          </div>
        </div>
      )}

      {step === "preview" && checked && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface p-4 text-sm">
            <span className="flex items-center gap-1.5 font-medium"><CheckCircle2 className="h-4 w-4 text-success" /> {okCount} ready to import</span>
            {checked.counts.duplicate > 0 && (
              <span className="flex items-center gap-1.5 text-warning"><Copy className="h-4 w-4" /> {checked.counts.duplicate} already entered — skipped</span>
            )}
            {checked.counts.error > 0 && (
              <span className="flex items-center gap-1.5 text-danger"><AlertCircle className="h-4 w-4" /> {checked.counts.error} with problems — left out</span>
            )}
          </div>

          {checked.newVendors.length > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary-50/40 p-4 text-sm">
              <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-primary-700" />
              <div>
                <p className="font-medium">
                  {checked.newVendors.length} new vendor{checked.newVendors.length === 1 ? "" : "s"} — will be created: {checked.newVendors.join(", ")}
                </p>
                <p className="mt-0.5 text-xs text-foreground-muted">
                  The file gives only their names: add their email and phone on the vendor&rsquo;s page afterwards.
                </p>
              </div>
            </div>
          )}

          {checked.counts.error > 0 && (
            <p className="text-xs text-foreground-muted">
              Rows with problems are left out — fix them in the file and import it again; what went in this time is
              skipped as already entered.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {([
              ["all", `All ${checked.rows.length}`],
              ["ok", `Ready ${checked.counts.ok}`],
              ["duplicate", `Duplicates ${checked.counts.duplicate}`],
              ["error", `Problems ${checked.counts.error}`],
            ] as const).map(([k, label]) => (
              <Button key={k} size="sm" variant={filter === k ? "secondary" : "ghost"} onClick={() => setFilter(k)}>{label}</Button>
            ))}
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-surface-muted">
                  <tr>
                    <th className="px-3 py-2.5 text-left text-xs font-medium text-foreground-muted">Row</th>
                    {kind.columns.map((c) => (
                      <th key={c.header} className={`whitespace-nowrap px-3 py-2.5 text-xs font-medium text-foreground-muted ${c.align === "right" ? "text-right" : "text-left"}`}>{c.header}</th>
                    ))}
                    <th className="px-3 py-2.5 text-left text-xs font-medium text-foreground-muted">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.row} className={`border-t border-border align-top ${r.status === "ok" ? "" : "bg-surface-muted/30"}`}>
                      <td className="px-3 py-2 text-foreground-muted">{r.row}</td>
                      {kind.columns.map((c) => (
                        <td key={c.header} className={`px-3 py-2 ${c.align === "right" ? "text-right" : ""} ${r.status === "ok" ? "" : "opacity-70"}`}>{c.cell(r)}</td>
                      ))}
                      <td className="min-w-[180px] px-3 py-2">
                        {r.status === "ok" && <Badge tone="success">Ready</Badge>}
                        {r.status === "duplicate" && (
                          <div className="space-y-1">
                            <Badge tone="warning">Duplicate — skipped</Badge>
                            <p className="text-xs text-foreground-muted">
                              {r.duplicateOf?.id ? <Link href={kind.recordHref(r.duplicateOf.id)} className="underline">{r.message}</Link> : r.message}
                            </p>
                          </div>
                        )}
                        {r.status === "error" && (
                          <div className="space-y-1">
                            <Badge tone="danger">Problem</Badge>
                            <p className="text-xs text-danger">{r.message}</p>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!shown.length && (
                    <tr><td colSpan={kind.columns.length + 2} className="px-3 py-8 text-center text-sm text-foreground-muted">No rows here.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {progress && (
            <div className="space-y-1">
              <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
              <p className="text-xs text-foreground-muted">Imported {progress.done} of {progress.total}…</p>
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <Button variant="outline" onClick={() => setStep("map")} disabled={!!progress}>Back</Button>
            <Button onClick={() => void runImport()} disabled={!!progress || okCount === 0} loading={!!progress}>
              {progress ? "Importing…" : `Import ${okCount} ${okCount === 1 ? one : many}`}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && outcome && (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-8 text-center">
            <div className={`flex h-16 w-16 items-center justify-center rounded-2xl ${outcome.stopped ? "bg-warning/10" : "bg-success/10"}`}>
              {outcome.stopped ? <AlertCircle className="h-8 w-8 text-warning" /> : <CheckCircle2 className="h-8 w-8 text-success" />}
            </div>
            <div>
              <h2 className="font-semibold text-foreground">
                {outcome.stopped ? "Import stopped part way" : "Import complete"}
              </h2>
              <p className="mt-1 text-sm text-foreground-muted">
                {outcome.created.length} {outcome.created.length === 1 ? one : many} imported
                {outcome.duplicates ? ` · ${outcome.duplicates} skipped as already entered` : ""}
                {outcome.errors.length ? ` · ${outcome.errors.length} not imported` : ""}
                {outcome.newVendors.length ? ` · ${outcome.newVendors.length} vendor${outcome.newVendors.length === 1 ? "" : "s"} added` : ""}
              </p>
              {outcome.stopped && (
                <p className="mt-2 text-sm text-danger">
                  {outcome.stopped.message} — {outcome.stopped.notSent} row{outcome.stopped.notSent === 1 ? " was" : "s were"} not sent.
                  Import the same file again: what already went in is skipped.
                </p>
              )}
              {outcome.batchId && <p className="mt-1 font-mono text-[11px] text-foreground-subtle">Batch {outcome.batchId}</p>}
            </div>
            <div className="flex gap-3">
              <Button variant="outline" onClick={reset}>Import another file</Button>
              <Button onClick={() => router.push(kind.backHref)}>{kind.backLabel}</Button>
            </div>
          </div>

          {outcome.warnings.length > 0 && (
            <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
              <p className="mb-2 font-medium">Imported, with something left to do</p>
              <ul className="space-y-1 text-xs">
                {outcome.warnings.map((w) => (
                  <li key={w.row}>
                    Row {w.row}: {w.id ? <Link href={kind.recordHref(w.id)} className="underline">{w.number}</Link> : w.number} — {w.warning}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {outcome.errors.length > 0 && (
            <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
              <p className="mb-2 font-medium">{outcome.errors.length} row{outcome.errors.length === 1 ? "" : "s"} not imported</p>
              <ul className="max-h-60 space-y-1 overflow-auto text-xs text-foreground-muted">
                {outcome.errors.map((e) => <li key={e.row}>Row {e.row}: {e.message}</li>)}
              </ul>
            </div>
          )}

          {(outcome.created.length > 0 || outcome.newVendors.length > 0) && (
            <div className="rounded-lg border border-border bg-surface p-4 text-sm">
              {outcome.newVendors.length > 0 && (
                <p className="mb-3">
                  <span className="font-medium">Vendors added: </span>
                  {outcome.newVendors.map((v, i) => (
                    <span key={v.id}>{i ? ", " : ""}<Link href={`/vendors/${v.id}`} className="underline">{v.name}</Link></span>
                  ))}
                </p>
              )}
              {outcome.created.length > 0 && (
                <>
                  <p className="mb-2 font-medium">Imported</p>
                  <div className="flex max-h-60 flex-wrap gap-x-3 gap-y-1 overflow-auto text-xs">
                    {outcome.created.map((c) => (
                      <Link key={c.row} href={kind.recordHref(c.id!)} className="font-mono text-primary-700 hover:underline">{c.number}</Link>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Header({ kind, sub }: { kind: ImportKind<string>; sub: string }) {
  const Icon = kind.icon;
  return (
    <div className="flex items-center gap-3">
      <Link
        href={kind.backHref}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-muted hover:text-foreground"
        aria-label={kind.backLabel}
      >
        <ArrowLeft className="h-4 w-4" />
      </Link>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{kind.title}</h1>
        {sub && <p className="text-sm text-foreground-muted">{sub}</p>}
      </div>
    </div>
  );
}
