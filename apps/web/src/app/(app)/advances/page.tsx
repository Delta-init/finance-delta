"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { HandCoins, Check, X, Loader2, Send, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  useAdvanceHistory, useSalaryAdvances, useApproveAdvance, useRejectAdvance,
  type AdvanceHistoryStatus, type SalaryAdvanceRecord, type SalaryAdvanceRequest,
} from "@/features/advances/api";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { PAYOUT_METHOD_LABELS, PayoutFields, emptyPayout, payoutValid, type Payout } from "@/features/hrms-payouts/payout-fields";
import { useAllDepartments } from "@/features/departments/api";

/** Radix reads "" as unset, so "no department" needs a value of its own. */
const NO_DEPARTMENT = "__none__";

type Tab = "pending" | "approved" | "rejected" | "all";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];
const isTab = (v: string | null): v is Tab => TABS.some((t) => t.key === v);

/**
 * Salary advances — finance's full record (the user, 2026-10-20), in tabs kept in the URL (?tab=):
 *
 *  - Pending: HR has approved them and they wait on finance — decided here — and, below, the ones still with HR.
 *  - Approved: paid out, with the expense recorded and the recovery HRMS is making.
 *  - Rejected: refused by HR or by finance, and why.
 *  - All: every one, newest first.
 *
 * The amount and the recovery are HR's — HRMS takes exactly that back from the
 * employee's pay, on that schedule — so nothing here changes them. "Mark paid"
 * records the payout as a paid expense — the date, the method and the bank
 * reference — and tells HRMS, which shows it Paid and starts the recovery.
 */
export default function AdvancesPage() {
  const [tab, setTabState] = useState<Tab>("pending");
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (isTab(t)) setTabState(t);
  }, []);
  const setTab = (t: Tab) => {
    setTabState(t);
    const p = new URLSearchParams(window.location.search);
    if (t === "pending") p.delete("tab"); else p.set("tab", t);
    window.history.replaceState(null, "", `${window.location.pathname}${p.size ? `?${p}` : ""}`);
  };

  const waiting = useSalaryAdvances();
  const waitingRows = waiting.data ?? [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={HandCoins}
        title="Salary advances"
        description="Every advance from HRMS: waiting on finance, still with HR, paid out and refused. Marking one paid records a paid expense and starts the recovery from pay in HRMS."
        action={waitingRows.length > 0 ? <Badge tone="warning">{waitingRows.length} waiting</Badge> : undefined}
      />

      <div className="flex w-fit gap-1 rounded-lg border border-border bg-surface p-1 text-sm" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1.5 font-medium ${tab === t.key ? "bg-primary text-primary-foreground" : "text-foreground-muted hover:bg-surface-muted"}`}
          >
            {t.label}
            {t.key === "pending" && waitingRows.length > 0 && <span className="ml-1.5 tabular-nums">({waitingRows.length})</span>}
          </button>
        ))}
      </div>

      {tab === "pending" ? (
        <>
          {waiting.isLoading ? (
            <Card className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>
          ) : waiting.error ? (
            <Card className="px-5 py-12 text-center text-sm text-foreground-muted">
              <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" />
              Could not reach HRMS. Check the integration settings and try again.
            </Card>
          ) : !waitingRows.length ? (
            <Card className="px-5 py-10 text-center text-sm text-foreground-muted">
              <HandCoins className="mx-auto mb-3 h-8 w-8 opacity-40" />
              Nothing is waiting on finance.
            </Card>
          ) : (
            <div className="space-y-4">
              {waitingRows.map((r) => <AdvanceCard key={`${r.hrmsOrgId}:${r._id}`} advance={r} />)}
            </div>
          )}
          <History status="pending" title="Still with HR" empty="Nothing is with HR." />
        </>
      ) : (
        <History status={tab} empty={tab === "approved" ? "No advance has been paid out yet." : tab === "rejected" ? "No advance has been refused." : "No advances yet."} />
      )}
    </div>
  );
}

// ── Finance's full record ─────────────────────────────────────────────────────

const STATUS: Record<SalaryAdvanceRecord["status"], { label: string; tone: "neutral" | "warning" | "success" | "danger" }> = {
  pending: { label: "With HR", tone: "neutral" },
  hr_approved: { label: "Waiting on finance", tone: "warning" },
  approved: { label: "Paid", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
};
const day = (v?: string | null) => (v ? String(v).slice(0, 10) : "");
const methodLabel = (m?: string) => (m ? (PAYOUT_METHOD_LABELS as Record<string, string>)[m] ?? m.replace(/_/g, " ") : "");

function History({ status, title, empty }: { status: AdvanceHistoryStatus; title?: string; empty: string }) {
  const { data, isLoading, error } = useAdvanceHistory(status);
  const rows = data ?? [];
  const message = error instanceof ApiError
    ? error.status === 404 ? "The finance API needs updating before it can show this." : error.message
    : "Could not reach HRMS. Check the integration settings and try again.";

  return (
    <section className="space-y-3">
      {title && (
        <h2 className="pt-2 text-sm font-semibold text-foreground">
          {title}{rows.length > 0 && <span className="ml-1.5 font-normal text-foreground-muted">({rows.length})</span>}
        </h2>
      )}
      {isLoading ? (
        <Card className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>
      ) : error ? (
        <Card className="px-5 py-10 text-center text-sm text-foreground-muted" data-testid="advance-history-error">
          <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" />
          {message}
        </Card>
      ) : !rows.length ? (
        <Card className="px-5 py-8 text-center text-sm text-foreground-muted">{empty}</Card>
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {rows.map((r) => <RecordRow key={`${r.hrmsOrgId}:${r._id}`} r={r} />)}
        </Card>
      )}
    </section>
  );
}

function RecordRow({ r }: { r: SalaryAdvanceRecord }) {
  const st = STATUS[r.status];
  const facts = [r.employee?.employeeCode, r.employee?.designation, r.employee?.department?.name].filter(Boolean);
  const perMonthMinor = r.months ? Math.round((r.amount * 100) / Math.max(1, r.months)) : 0;
  const hrRefused = r.status === "rejected" && r.rejectedBy === "hr";
  const financeRefused = r.status === "rejected" && r.rejectedBy === "finance";
  const expense = r.expense && r.expense.status !== "voided" ? r.expense : null;

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{r.employee?.name ?? "Employee"}</h3>
          <Badge tone={st.tone}>{hrRefused ? "Rejected by HR" : financeRefused ? "Rejected by finance" : st.label}</Badge>
          {r.overLimit && <Badge tone="warning">Over one month&apos;s salary</Badge>}
        </div>
        {facts.length > 0 && <p className="text-sm text-foreground-muted">{facts.join(" · ")}</p>}
        {r.reason && <p className="text-sm">{r.reason}</p>}
        <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-xs text-foreground-muted">
          <span>Asked <span className="text-foreground">{day(r.createdAt)}</span>{r.raisedBy?.name ? <> by HR (<span className="text-foreground">{r.raisedBy.name}</span>)</> : null}</span>
          {r.neededBy && <span>Needed by <span className="text-foreground">{day(r.neededBy)}</span></span>}
          {r.hrReviewedBy?.name && r.status !== "pending" && (
            <span>{hrRefused ? "Refused" : "Approved"} by HR: <span className="text-foreground">{r.hrReviewedBy.name}</span>{r.hrReviewedAt ? `, ${day(r.hrReviewedAt)}` : ""}</span>
          )}
          {r.hrNote && <span>HR&apos;s note: <span className="text-foreground">{r.hrNote}</span></span>}
          {r.months && r.startMonth && !hrRefused && (
            <span>Recovery: <span className="text-foreground"><MoneyDisplay minor={perMonthMinor} currency={r.currency} /> a month × {r.months}, from {r.startMonth}</span></span>
          )}
          {r.status === "approved" && (
            <span>
              Paid{r.paidOn ? <> on <span className="text-foreground">{day(r.paidOn)}</span></> : null}
              {r.paymentMethod ? <> by <span className="text-foreground">{methodLabel(r.paymentMethod)}</span></> : null}
              {expense ? <> — <Link href={`/expenses/${expense.id}`} className="font-medium text-primary hover:underline">{expense.expenseNumber}</Link></> : r.financeRef ? <> — <span className="text-foreground">{r.financeRef}</span></> : null}
            </span>
          )}
          {financeRefused && r.financeReviewedAt && <span>Refused by finance on <span className="text-foreground">{day(r.financeReviewedAt)}</span></span>}
          {r.financeNote && <span>Finance&apos;s note: <span className="text-foreground">{r.financeNote}</span></span>}
        </div>
      </div>
      <div className="shrink-0 sm:text-right">
        <MoneyDisplay minor={Math.round(r.amount * 100)} currency={r.currency} className="text-base font-semibold" />
      </div>
    </div>
  );
}

function AdvanceCard({ advance: r }: { advance: SalaryAdvanceRequest }) {
  const categories = useExpenseCategories();
  const departments = useAllDepartments();
  const approve = useApproveAdvance();
  const reject = useRejectAdvance();

  const [category, setCategory] = useState<string | null>(null);
  const [department, setDepartment] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [payout, setPayout] = useState<Payout>(emptyPayout);

  // "Salaries & Wages" when this org has it — an advance is pay, early.
  const categoryList = categories.data ?? [];
  const chosenCategory = category ?? (categoryList.some((c) => c.slug === "salaries_wages") ? "salaries_wages" : categoryList[0]?.slug ?? "");
  const departmentList = departments.data ?? [];
  const suggested = r.suggestedDepartmentId && departmentList.some((d) => d.id === r.suggestedDepartmentId) ? r.suggestedDepartmentId : NO_DEPARTMENT;
  const chosenDepartment = department ?? suggested;
  const busy = approve.isPending || reject.isPending;

  const made = r.expense && r.expense.status !== "voided" ? r.expense : null;
  const voided = r.expense?.status === "voided" ? r.expense : null;
  const id = (field: string) => `advance-${r._id}-${field}`;
  const perMonthMinor = Math.round((r.amount * 100) / Math.max(1, r.months));

  const onApprove = async () => {
    const res = await approve.mutateAsync({
      id: r._id,
      hrmsOrgId: r.hrmsOrgId,
      note: note.trim(),
      ...payout,
      ...(made ? {} : { category: chosenCategory, departmentId: chosenDepartment === NO_DEPARTMENT ? "" : chosenDepartment }),
    });
    toast.success(`Paid — ${res.expense.expenseNumber} recorded, and HRMS will recover it from pay`);
  };

  const onReject = async () => {
    await reject.mutateAsync({ id: r._id, hrmsOrgId: r.hrmsOrgId, note: note.trim() });
    toast.success("Rejected — the employee and HR have been told");
  };

  const facts = [
    r.employee?.employeeCode,
    r.employee?.designation,
    r.employee?.department?.name,
    r.neededBy ? `Needed by ${String(r.neededBy).slice(0, 10)}` : null,
  ].filter(Boolean);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-semibold">{r.employee?.name ?? "Employee"}</h3>
          {facts.length > 0 && <p className="text-sm text-foreground-muted">{facts.join(" · ")}</p>}
          {r.reason && <p className="text-sm">{r.reason}</p>}
          <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-xs text-foreground-muted">
            <span>
              Recovery: <span className="text-foreground"><MoneyDisplay minor={perMonthMinor} currency={r.currency} /> a month × {r.months}, from {r.startMonth}</span>
            </span>
            <span>Monthly salary: <span className="text-foreground"><MoneyDisplay minor={Math.round(r.monthlySalary * 100)} currency={r.currency} /></span></span>
            {r.hrReviewedBy?.name && <span>Approved by <span className="text-foreground">{r.hrReviewedBy.name}</span></span>}
            {r.hrNote && <span>HR&apos;s note: <span className="text-foreground">{r.hrNote}</span></span>}
          </div>
        </div>
        <div className="shrink-0 sm:text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Advance</p>
          <MoneyDisplay minor={Math.round(r.amount * 100)} currency={r.currency} className="text-lg font-semibold" />
        </div>
      </div>

      {made && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            <Link href={`/expenses/${made.id}`} className="font-medium text-primary underline-offset-2 hover:underline">{made.expenseNumber}</Link>{" "}
            has been recorded for this advance, but HRMS has not been told yet. Send it again — no second expense is made.
          </span>
        </div>
      )}
      {voided && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <span>{voided.expenseNumber} was recorded for this advance and then voided. Reject it instead.</span>
        </div>
      )}

      <div className="space-y-4 border-t border-border bg-surface-muted/50 p-5">
        {!made && !voided && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <PayoutFields value={payout} onChange={setPayout} idPrefix={id("payout")} />
            <div className="space-y-1.5">
              <Label htmlFor={id("category")}>Category</Label>
              <Select value={chosenCategory} onValueChange={setCategory} disabled={categories.isLoading}>
                <SelectTrigger id={id("category")}><SelectValue placeholder={categories.isLoading ? "Loading…" : "Choose a category"} /></SelectTrigger>
                <SelectContent>
                  {categoryList.map((c) => <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id("department")}>Department (optional)</Label>
              <Select value={chosenDepartment} onValueChange={setDepartment} disabled={departments.isLoading}>
                <SelectTrigger id={id("department")}><SelectValue placeholder="No department" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEPARTMENT}>No department</SelectItem>
                  {departmentList.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={id("note")}>Note (optional)</Label>
            <Input id={id("note")} value={note} maxLength={500} placeholder="Sent to the employee and HR with the decision"
              onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex shrink-0 gap-2">
            {!voided && (
              <Button onClick={() => void onApprove().catch(() => undefined)} disabled={busy || (!made && (!chosenCategory || !payoutValid(payout)))}>
                {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : made ? <Send className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                {made ? "Send to HRMS" : "Mark paid"}
              </Button>
            )}
            <Button variant="outline" onClick={() => void onReject().catch(() => undefined)} disabled={busy || !!made}
              title={made ? `Void ${made.expenseNumber} before rejecting` : undefined}>
              {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}Reject
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
