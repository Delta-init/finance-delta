"use client";

import { use, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Upload, FileText, X, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import { useBankAccount, useBulkImportTransactions } from "@/features/banking/api";
import type { CreateBankTransactionInput } from "@delta/shared";

type ParsedRow = {
  date: string;
  description: string;
  amountMinor: number;
  reference: string;
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

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const parse = (line: string): string[] => {
    const result: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === "," && !inQuotes) { result.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    result.push(cur.trim());
    return result;
  };
  return { headers: parse(lines[0]!), rows: lines.slice(1).map(parse) };
}

function toMinor(val: string): number {
  const cleaned = val.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

function mapRows(rows: string[][], headers: string[], mapping: ColumnMapping): ParsedRow[] {
  return rows
    .filter((r) => r.some((c) => c.trim()))
    .map((row) => {
      const get = (col: string) => {
        const idx = headers.indexOf(col);
        return idx >= 0 ? (row[idx] ?? "") : "";
      };

      let amountMinor = 0;
      if (mapping.amountType === "signed") {
        amountMinor = toMinor(get(mapping.amount));
      } else {
        const credit = toMinor(get(mapping.creditColumn));
        const debit = toMinor(get(mapping.debitColumn));
        amountMinor = credit - Math.abs(debit);
      }

      return {
        date: get(mapping.date),
        description: get(mapping.description),
        amountMinor,
        reference: mapping.reference ? get(mapping.reference) : "",
      };
    })
    .filter((r) => r.date && r.description);
}

export default function ImportTransactionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data: account } = useBankAccount(id);
  const bulkImport = useBulkImportTransactions(id);

  const fileRef = useRef<HTMLInputElement>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [step, setStep] = useState<"upload" | "map" | "preview" | "done">("upload");

  const [mapping, setMapping] = useState<ColumnMapping>({
    date: "",
    description: "",
    amount: "",
    reference: "",
    amountType: "signed",
    creditColumn: "",
    debitColumn: "",
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { headers: h, rows: r } = parseCSV(text);
      setHeaders(h);
      setRows(r);
      const guessCol = (keywords: string[]) =>
        h.find((hd) => keywords.some((k) => hd.toLowerCase().includes(k))) ?? "";
      setMapping((m) => ({
        ...m,
        date: guessCol(["date"]),
        description: guessCol(["description", "narration", "detail", "particular"]),
        amount: guessCol(["amount", "value"]),
        reference: guessCol(["reference", "ref", "cheque", "check"]),
      }));
      setStep("map");
    };
    reader.readAsText(file);
  }

  function handleMapContinue() {
    const mapped = mapRows(rows, headers, mapping);
    setParsed(mapped);
    setStep("preview");
  }

  async function handleImport() {
    try {
      const transactions: CreateBankTransactionInput[] = parsed.map((r) => ({
        date: r.date,
        description: r.description,
        amountMinor: r.amountMinor,
        reference: r.reference,
        notes: "",
      }));
      const result = await bulkImport.mutateAsync({
        transactions,
        importBatchId: `import-${Date.now()}`,
      });
      toast.success(`Imported ${result.count} transactions`);
      setStep("done");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Import failed");
    }
  }

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

      {/* Step indicators */}
      <div className="flex items-center gap-2 text-sm">
        {(["upload", "map", "preview"] as const).map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            {i > 0 && <span className="text-foreground-subtle">›</span>}
            <span
              className={
                step === s
                  ? "font-semibold text-foreground"
                  : (["upload", "map", "preview"].indexOf(step) > i
                    ? "text-success"
                    : "text-foreground-muted")
              }
            >
              {i + 1}. {s.charAt(0).toUpperCase() + s.slice(1)}
            </span>
          </span>
        ))}
      </div>

      {/* Step 1: Upload */}
      {step === "upload" && (
        <div className="rounded-lg border border-border bg-surface p-8 flex flex-col items-center gap-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-muted">
            <Upload className="h-8 w-8 text-foreground-subtle" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground">Upload CSV file</h2>
            <p className="mt-1 text-sm text-foreground-muted">
              Export your bank statement as CSV and upload it here. OFX support coming soon.
            </p>
          </div>
          <Button onClick={() => fileRef.current?.click()}>
            <FileText className="h-4 w-4" /> Choose file
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      )}

      {/* Step 2: Map columns */}
      {step === "map" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface p-4 flex items-center gap-3">
            <FileText className="h-5 w-5 text-foreground-muted shrink-0" />
            <span className="text-sm font-medium">{fileName}</span>
            <span className="text-xs text-foreground-muted">({rows.length} rows, {headers.length} columns)</span>
            <button
              onClick={() => { setStep("upload"); setHeaders([]); setRows([]); setFileName(""); }}
              className="ml-auto text-foreground-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="rounded-lg border border-border bg-surface p-6 space-y-4">
            <h2 className="text-sm font-semibold text-foreground-muted uppercase tracking-wide">Map Columns</h2>

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
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
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
                    <SelectItem value="signed">Single column (+ credit, - debit)</SelectItem>
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
                    <Label>Credit column *</Label>
                    <Select value={mapping.creditColumn} onValueChange={(v) => setMapping((m) => ({ ...m, creditColumn: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                      <SelectContent>
                        {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Debit column *</Label>
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

          {/* Preview of first 3 rows */}
          {rows.length > 0 && headers.length > 0 && (
            <div className="rounded-lg border border-border bg-surface overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <p className="text-xs font-semibold text-foreground-muted uppercase tracking-wide">
                  Preview (first 3 rows)
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-surface-muted">
                    <tr>
                      {headers.map((h) => (
                        <th key={h} className="px-3 py-2 text-left font-medium text-foreground-muted">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 3).map((row, i) => (
                      <tr key={i} className="border-t border-border">
                        {row.map((cell, j) => (
                          <td key={j} className="px-3 py-2 text-foreground-muted max-w-[120px] truncate">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <Button variant="outline" onClick={() => setStep("upload")}>Back</Button>
            <Button
              onClick={handleMapContinue}
              disabled={!mapping.date || !mapping.description || (mapping.amountType === "signed" ? !mapping.amount : !mapping.creditColumn || !mapping.debitColumn)}
            >
              Preview Import
            </Button>
          </div>
        </div>
      )}

      {/* Step 3: Preview mapped data */}
      {step === "preview" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface p-4 flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-success shrink-0" />
            <span className="text-sm font-medium">{parsed.length} transactions ready to import</span>
            {parsed.some((r) => !r.date || r.amountMinor === 0) && (
              <span className="flex items-center gap-1 text-xs text-warning ml-auto">
                <AlertCircle className="h-3.5 w-3.5" /> Some rows may have issues
              </span>
            )}
          </div>

          <div className="rounded-lg border border-border bg-surface overflow-hidden">
            <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
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
                  {parsed.map((row, i) => (
                    <tr key={i} className="border-t border-border hover:bg-surface-muted/50">
                      <td className="px-4 py-2.5 text-foreground-muted">{row.date}</td>
                      <td className="px-4 py-2.5 max-w-xs truncate">{row.description}</td>
                      <td className="px-4 py-2.5 text-foreground-muted text-xs">{row.reference}</td>
                      <td className={`px-4 py-2.5 text-right font-mono font-medium ${row.amountMinor >= 0 ? "text-success" : "text-danger"}`}>
                        {row.amountMinor >= 0 ? "+" : ""}
                        {(row.amountMinor / 100).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            <Button variant="outline" onClick={() => setStep("map")}>Back</Button>
            <Button onClick={handleImport} disabled={bulkImport.isPending || parsed.length === 0}>
              {bulkImport.isPending ? "Importing…" : `Import ${parsed.length} transactions`}
            </Button>
          </div>
        </div>
      )}

      {/* Done */}
      {step === "done" && (
        <div className="rounded-lg border border-border bg-surface p-8 flex flex-col items-center gap-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-success/10">
            <CheckCircle2 className="h-8 w-8 text-success" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground">Import complete</h2>
            <p className="mt-1 text-sm text-foreground-muted">
              Transactions have been added to your account.
            </p>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setStep("upload")}>Import more</Button>
            <Button onClick={() => router.push(`/banking/${id}`)}>View transactions</Button>
          </div>
        </div>
      )}
    </div>
  );
}
