"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { ReconciliationSession, StatementCheck, StatementCheckLine } from "@delta/shared";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileText, RefreshCw, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MoneyDisplay } from "@/components/ui/money";
import { useFileDrop } from "@/components/ui/file-drop";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { CategoryPicker, useCategoryChoice } from "@/features/expense-categories/CategoryPicker";
import { useCheckStatement, useStatementAdd, useStatementCharge, useUploadStatementFile } from "./api";
import { downloadTemplate, parseStatementRows, readStatementRows } from "./statement-file";

/**
 * Reconcile by uploading the bank statement (the user, 2026-11-07: "they upload it on that form, then we check it
 * ourselves — if it is correct it reconciles, otherwise how much and which transaction is not correct"). The template
 * or the bank's own export, read here; checked against the account's lines; what matched is ticked below with the
 * statement's day. What doesn't match is listed with what to do about it.
 */
export function StatementCheckPanel({ accountId, session, onChecked, onReconcile, reconciling }: {
  accountId: string;
  session: ReconciliationSession;
  /** The ticks and statement dates the check left, for the list below. */
  onChecked: (session: ReconciliationSession) => void;
  /** Complete it: everything (all matched) or just what matched (`partial`). */
  onReconcile: (partial: boolean) => void;
  reconciling: boolean;
}) {
  const [check, setCheck] = useState<StatementCheck | null>((session.statementCheck as StatementCheck | undefined) ?? null);
  const [file, setFile] = useState<{ name: string; url?: string } | null>(session.statementFile ?? null);
  const [problems, setProblems] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [confirmPartial, setConfirmPartial] = useState(false);
  const [adding, setAdding] = useState<StatementCheckLine | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadStatementFile(accountId, session.id);
  const run = useCheckStatement(accountId, session.id);
  const charge = useStatementCharge(accountId, session.id);
  const cur = session.currency;

  const took = (r: { check: StatementCheck; session: ReconciliationSession }) => { setCheck(r.check); onChecked(r.session); };
  const fail = (e: unknown, what: string) => toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : what);

  async function readFile(f: File) {
    setReading(true);
    setProblems([]);
    try {
      const read = parseStatementRows(await readStatementRows(f));
      setProblems(read.problems);
      if (!read.lines.length) throw new Error("No transactions could be read from that file");
      // The file kept as evidence — a storage hiccup doesn't stop the check.
      const kept = await upload.mutateAsync(f).catch(() => null);
      setFile(kept ?? { name: f.name });
      took(await run.mutateAsync({ lines: read.lines, fileName: f.name }));
      toast.success(`${read.lines.length} statement lines checked`);
    } catch (e) {
      fail(e, "Could not read that file");
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }
  const drop = useFileDrop({
    onFiles: ([f]) => { if (f) void readFile(f); },
    accept: ".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel",
    disabled: reading,
  });

  async function again() {
    try { took(await run.mutateAsync({})); } catch (e) { fail(e, "Could not check it again"); }
  }
  async function recordCharge(l: StatementCheckLine) {
    try { took(await charge.mutateAsync(l.index)); toast.success("Bank charge recorded — the line matches now"); } catch (e) { fail(e, "Could not record the charge"); }
  }

  const lines = check?.lines ?? [];
  const differs = lines.filter((l) => l.status === "amount_differs");
  const missing = lines.filter((l) => l.status === "not_in_books");
  const matched = lines.filter((l) => l.status === "matched");
  const s = check?.summary;

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><FileSpreadsheet className="h-4 w-4" /> Check against the bank statement</h2>
          <p className="text-xs text-foreground-muted">
            Upload the statement — the template, or the bank&rsquo;s own CSV or Excel export. Each line is matched to one here by amount, reference and date
            (up to {check?.windowDays ?? 3} days apart); what matches is ticked below with the statement&rsquo;s day.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => void downloadTemplate("xlsx")}><Download className="h-3.5 w-3.5" /> Template (Excel)</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void downloadTemplate("csv")}><Download className="h-3.5 w-3.5" /> Template (CSV)</Button>
        </div>
      </div>

      <div className="relative rounded-lg border border-dashed border-border p-4" {...drop.zoneProps}>
        {drop.overlay}
        <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" loading={reading || run.isPending} onClick={() => inputRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" /> {check ? "Upload another statement" : "Upload the statement"}
          </Button>
          {file && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground-muted">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              {file.url ? <a href={file.url} target="_blank" rel="noopener noreferrer" className="truncate text-primary hover:underline">{file.name}</a> : <span className="truncate">{file.name}</span>}
            </span>
          )}
          {check && (
            <Button type="button" size="sm" variant="ghost" loading={run.isPending && !reading} onClick={() => void again()}>
              <RefreshCw className="h-3.5 w-3.5" /> Check again
            </Button>
          )}
        </div>
        {drop.hint}
      </div>

      {problems.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5 text-warning" /> {problems.length} row{problems.length === 1 ? "" : "s"} couldn&rsquo;t be read and were left out</p>
          <ul className="mt-1 list-disc pl-5 text-foreground-muted">{problems.slice(0, 8).map((p) => <li key={p}>{p}</li>)}{problems.length > 8 && <li>…and {problems.length - 8} more</li>}</ul>
        </div>
      )}

      {check && s && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone="neutral">{s.statementLines} lines</Badge>
            <Badge tone="success">{s.matched} matched</Badge>
            {s.amountDiffers > 0 && <Badge tone="warning">{s.amountDiffers} amount differs</Badge>}
            {s.notInBooks > 0 && <Badge tone="danger">{s.notInBooks} not in the books</Badge>}
            {s.notOnStatement > 0 && <Badge tone="danger">{s.notOnStatement} not on the statement</Badge>}
            {s.closingAgrees === false && s.fileClosingMinor !== null && (
              <span className="text-warning">The file closes at <MoneyDisplay minor={s.fileClosingMinor} currency={cur} />, not the <MoneyDisplay minor={session.statementBalanceMinor} currency={cur} /> typed in</span>
            )}
          </div>

          {check.allMatch ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/30 bg-success/5 p-3">
              <p className="flex items-center gap-2 text-sm font-medium text-success"><CheckCircle2 className="h-4 w-4" /> Every line on the statement matches, nothing left over — the difference is nil.</p>
              <Button type="button" size="sm" loading={reconciling} onClick={() => onReconcile(false)}>Reconcile</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/20 bg-danger/5 p-3">
              <p className="text-sm">
                <span className="font-medium text-danger">Not reconciled yet.</span>{" "}
                {s.unexplainedMinor !== 0 && <>What doesn&rsquo;t agree comes to <MoneyDisplay minor={s.unexplainedMinor} currency={cur} className="font-medium" />. </>}
                Put the lines below right and check again — or reconcile what matched now.
              </p>
              {matched.length > 0 && <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmPartial(true)}>Reconcile the {matched.length} matched</Button>}
            </div>
          )}

          {differs.length > 0 && (
            <Section title="Amount differs" note="The same transaction, but the statement and the books disagree on the amount.">
              {differs.map((l) => (
                <Row key={l.index} l={l} cur={cur} accountId={accountId}
                  extra={<>books <MoneyDisplay minor={l.bookLines[0]?.amountMinor ?? 0} currency={cur} /> · difference <MoneyDisplay minor={l.differenceMinor ?? 0} currency={cur} className="font-medium text-danger" /></>}
                  action={(l.differenceMinor ?? 0) < 0
                    ? <Button type="button" size="sm" variant="secondary" loading={charge.isPending && charge.variables === l.index} onClick={() => void recordCharge(l)}>Record <MoneyDisplay minor={-(l.differenceMinor ?? 0)} currency={cur} /> as bank charge</Button>
                    : <span className="text-xs text-foreground-muted">Correct the entry, then check again</span>} />
              ))}
            </Section>
          )}
          {missing.length > 0 && (
            <Section title="On the statement, not in the books" note="Money the bank shows that finance has no line for.">
              {missing.map((l) => (
                <Row key={l.index} l={l} cur={cur} accountId={accountId}
                  action={<Button type="button" size="sm" variant="secondary" onClick={() => setAdding(l)}>Add to books</Button>} />
              ))}
            </Section>
          )}
          {check.notOnStatement.length > 0 && (
            <Section title="In the books, not on the statement" note="Lines here the bank doesn't show — a cheque not yet cleared, or a wrong date or amount.">
              {check.notOnStatement.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <span className="w-24 shrink-0 tabular-nums text-foreground-muted">{b.date}</span>
                  <span className="min-w-0 flex-1 break-words">{b.description}{b.reference ? <span className="text-foreground-muted"> · {b.reference}</span> : null}</span>
                  <MoneyDisplay minor={b.amountMinor} currency={cur} className={b.amountMinor < 0 ? "text-danger" : "text-success"} />
                  <Link href={`/banking/${accountId}?${new URLSearchParams({ q: b.reference || b.description, from: b.date, to: b.date })}`} className="text-xs text-primary hover:underline">Open</Link>
                </div>
              ))}
            </Section>
          )}
          {matched.length > 0 && (
            <details className="rounded-lg border border-border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Matched ({matched.length}) — ticked below</summary>
              <div className="divide-y divide-border border-t border-border">
                {matched.map((l) => <Row key={l.index} l={l} cur={cur} accountId={accountId} extra={l.bookLines.length > 1 ? <>with its bank charge</> : l.bookLines[0] && l.bookLines[0].date !== l.date ? <>books {l.bookLines[0].date}</> : null} />)}
              </div>
            </details>
          )}
          <p className="text-xs text-foreground-muted">Checked {new Date(check.checkedAt).toLocaleString()}{check.fileName ? ` · ${check.fileName}` : ""}</p>
        </>
      )}

      <Dialog open={confirmPartial} onOpenChange={setConfirmPartial}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reconcile the matched lines</DialogTitle>
            <DialogDescription>
              The {matched.length} matched line{matched.length === 1 ? "" : "s"} are reconciled with the statement&rsquo;s days. The rest stay open for the next
              reconciliation, and this one is recorded with its difference of <MoneyDisplay minor={session.differenceMinor} currency={cur} />.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmPartial(false)}>Cancel</Button>
            <Button loading={reconciling} onClick={() => { setConfirmPartial(false); onReconcile(true); }}>Reconcile {matched.length}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AddToBooksDialog accountId={accountId} sessionId={session.id} line={adding} currency={cur} onClose={() => setAdding(null)} onDone={(r) => { setAdding(null); took(r); }} />
    </Card>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-foreground-muted">{note}</p>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">{children}</div>
    </div>
  );
}

function Row({ l, cur, accountId, extra, action }: { l: StatementCheckLine; cur: string; accountId: string; extra?: React.ReactNode; action?: React.ReactNode }) {
  const book = l.bookLines[0];
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
      <span className="w-24 shrink-0 tabular-nums text-foreground-muted">{l.date}</span>
      <span className="min-w-0 flex-1 break-words">
        {l.description || "—"}{l.reference ? <span className="text-foreground-muted"> · {l.reference}</span> : null}
        {(extra || book) && (
          <span className="block text-xs text-foreground-muted">
            {book && <Link href={`/banking/${accountId}?${new URLSearchParams({ q: book.reference || book.description, from: book.date, to: book.date })}`} className="text-primary hover:underline">{book.description}</Link>}
            {book && extra ? " · " : null}{extra}
          </span>
        )}
      </span>
      <MoneyDisplay minor={l.amountMinor} currency={cur} className={`tabular-nums ${l.amountMinor < 0 ? "text-danger" : "text-success"}`} />
      {action}
    </div>
  );
}

/** A statement line the books lack: money out as an expense (its category, Bank Charges to start with), money in as an entry. */
function AddToBooksDialog({ accountId, sessionId, line, currency, onClose, onDone }: {
  accountId: string; sessionId: string; line: StatementCheckLine | null; currency: string;
  onClose: () => void; onDone: (r: { check: StatementCheck; session: ReconciliationSession }) => void;
}) {
  const add = useStatementAdd(accountId, sessionId);
  const categories = useExpenseCategories();
  const list = categories.data ?? [];
  const cat = useCategoryChoice(list, { category: "bank_fees", subcategory: "bank_charges" });
  const out = (line?.amountMinor ?? 0) < 0;
  async function submit() {
    if (!line) return;
    try {
      onDone(await add.mutateAsync({ index: line.index, input: out ? { category: cat.value.category, subcategory: cat.value.subcategory || undefined } : {} }));
      toast.success(out ? "Recorded as a paid expense — the line matches now" : "Added to the account — the line matches now");
      cat.reset();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not add it");
    }
  }
  return (
    <Dialog open={!!line} onOpenChange={(o) => { if (!o) { cat.reset(); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add to books</DialogTitle>
          <DialogDescription>
            {line && <>{line.date} · {line.description || "—"} · <MoneyDisplay minor={line.amountMinor} currency={currency} />. </>}
            {out ? "Recorded as an expense paid from this account on the statement's day." : "Recorded as money in, in this account, on the statement's day."}
          </DialogDescription>
        </DialogHeader>
        {out && <div className="grid gap-3 sm:grid-cols-2"><CategoryPicker categories={list} value={cat.value} onChange={cat.set} idPrefix="statement-add" loading={categories.isLoading} /></div>}
        <DialogFooter>
          <Button variant="secondary" onClick={() => { cat.reset(); onClose(); }}>Cancel</Button>
          <Button loading={add.isPending} disabled={out && !cat.complete} onClick={() => void submit()}>Add to books</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
