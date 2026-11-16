"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ReceiptText, Check, X, Loader2, Send, AlertTriangle, Paperclip } from "lucide-react";
import { EXPENSE_DEFAULTS } from "@delta/shared";
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
  useReimbursements, useReimbursementHistory, usePayReimbursement, useRejectReimbursement,
  type ReimbursementClaim, type ReimbursementHistoryStatus, type WaitingClaim,
} from "@/features/reimbursements/api";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { CategoryPicker, useCategoryChoice } from "@/features/expense-categories/CategoryPicker";
import { useAllDepartments } from "@/features/departments/api";
import { PAYOUT_METHOD_LABELS, PayoutFields, emptyPayout, payoutValid, type Payout } from "@/features/hrms-payouts/payout-fields";

/** Radix reads "" as unset, so "no department" needs a value of its own. */
const NO_DEPARTMENT = "__none__";

type Tab = "waiting" | "paid" | "rejected" | "all";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "waiting", label: "Waiting" },
  { key: "paid", label: "Paid" },
  { key: "rejected", label: "Refused" },
  { key: "all", label: "All" },
];
const isTab = (v: string | null): v is Tab => TABS.some((t) => t.key === v);

const CATEGORY_WORDS: Record<string, string> = {
  travel: "Travel", food: "Food", accommodation: "Accommodation", medical: "Medical",
  communication: "Communication", fuel: "Fuel", supplies: "Supplies", other: "Other",
};
const categoryWord = (c: string) => CATEGORY_WORDS[c] ?? c;
const day = (v?: string | null) => (v ? String(v).slice(0, 10) : "");
const methodLabel = (m?: string) => (m ? (PAYOUT_METHOD_LABELS as Record<string, string>)[m] ?? m.replace(/_/g, " ") : "");

/**
 * Employees' reimbursement claims from HRMS (the user, 2026-11-16: "employee request => HR approval => finance
 * approval (paid status)"). HR approved each one in HRMS; finance pays it here — "Approve and pay" records a paid
 * expense, and HRMS shows the claim Paid with the expense number — or refuses it, saying why. The amount is what was
 * claimed unless finance changes it ("finance can edit the amount… it will show in HRMS also"): HRMS then shows what
 * was paid and what was claimed; more than claimed needs a note.
 * A claim paid here never goes into a payslip.
 *
 * Tabs, kept in the URL (?tab=): Waiting — decided here; Paid; Refused — by finance; All — every claim that reached
 * finance, newest first.
 */
export default function ReimbursementsPage() {
  const [tab, setTabState] = useState<Tab>("waiting");
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (isTab(t)) setTabState(t);
  }, []);
  const setTab = (t: Tab) => {
    setTabState(t);
    const p = new URLSearchParams(window.location.search);
    if (t === "waiting") p.delete("tab"); else p.set("tab", t);
    window.history.replaceState(null, "", `${window.location.pathname}${p.size ? `?${p}` : ""}`);
  };

  const { data, isLoading, error } = useReimbursements();
  const rows = data ?? [];
  const errorText = error instanceof ApiError ? error.message : "Could not reach HRMS. Check the integration settings and try again.";

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={ReceiptText}
        title="Reimbursements"
        description="Employees' expense claims HR approved in HRMS, for finance to pay: waiting, paid and refused. Approving one pays it — a paid expense for the amount claimed, or the amount you change it to — and the employee sees it Paid in HRMS."
        action={rows.length > 0 ? <Badge tone="warning">{rows.length} waiting</Badge> : undefined}
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
            {t.key === "waiting" && rows.length > 0 && <span className="ml-1.5 tabular-nums">({rows.length})</span>}
          </button>
        ))}
      </div>

      {tab !== "waiting" ? (
        <History status={tab} empty={tab === "paid" ? "No claim has been paid here yet." : tab === "rejected" ? "No claim has been refused." : "No claims have reached finance yet."} />
      ) : isLoading ? (
        <Card className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>
      ) : error ? (
        <Card className="px-5 py-12 text-center text-sm text-foreground-muted">
          <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" />
          {errorText}
        </Card>
      ) : !rows.length ? (
        <Card className="px-5 py-16 text-center text-sm text-foreground-muted">
          <ReceiptText className="mx-auto mb-3 h-8 w-8 opacity-40" />
          No claims are waiting to be paid.
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => <ClaimCard key={`${r.hrmsOrgId}:${r._id}`} claim={r} />)}
        </div>
      )}
    </div>
  );
}

/** What HRMS says about the claim: who, what, when, the receipt and HR's approval. */
function ClaimFacts({ r }: { r: ReimbursementClaim }) {
  const facts = [r.employee?.employeeCode, r.employee?.designation, r.employee?.department?.name].filter(Boolean);
  return (
    <div className="min-w-0 space-y-1">
      <h3 className="text-base font-semibold">{r.title} · {r.employee?.name ?? "Employee"}</h3>
      {facts.length > 0 && <p className="text-sm text-foreground-muted">{facts.join(" · ")}</p>}
      <p className="text-sm text-foreground-muted">
        {categoryWord(r.category)}{r.expenseDate ? ` · spent ${day(r.expenseDate)}` : ""}{r.month ? ` · for ${r.month}` : ""}
      </p>
      {r.description && <p className="text-sm">{r.description}</p>}
      <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-xs text-foreground-muted">
        {r.receiptUrl ? (
          <a href={r.receiptUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
            <Paperclip className="h-3.5 w-3.5" />Receipt
          </a>
        ) : <span>No receipt attached</span>}
        {(r.hrReviewedBy?.name || r.hrReviewedAt) && (
          <span>Approved in HR{r.hrReviewedBy?.name ? <> by <span className="text-foreground">{r.hrReviewedBy.name}</span></> : null}{r.hrReviewedAt ? <> on <span className="text-foreground">{day(r.hrReviewedAt)}</span></> : null}</span>
        )}
        {r.hrNote && <span>HR&apos;s note: <span className="text-foreground">{r.hrNote}</span></span>}
      </div>
    </div>
  );
}

// ── Finance's record ──────────────────────────────────────────────────────────

const STATUS: Record<ReimbursementClaim["status"], { label: string; tone: "warning" | "success" | "danger" }> = {
  hr_approved: { label: "Waiting on finance", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  rejected: { label: "Refused", tone: "danger" },
};

function History({ status, empty }: { status: ReimbursementHistoryStatus; empty: string }) {
  const { data, isLoading, error } = useReimbursementHistory(status);
  const rows = data ?? [];
  const message = error instanceof ApiError
    ? error.status === 404 ? "The finance API needs updating before it can show this." : error.message
    : "Could not reach HRMS. Check the integration settings and try again.";

  if (isLoading) return <Card className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>;
  if (error) {
    return (
      <Card className="px-5 py-10 text-center text-sm text-foreground-muted">
        <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" />
        {message}
      </Card>
    );
  }
  if (!rows.length) return <Card className="px-5 py-8 text-center text-sm text-foreground-muted">{empty}</Card>;
  return (
    <Card className="divide-y divide-border overflow-hidden">
      {rows.map((r) => <RecordRow key={`${r.hrmsOrgId}:${r._id}`} r={r} />)}
    </Card>
  );
}

function RecordRow({ r }: { r: ReimbursementClaim & { hrmsOrgId: string } }) {
  const st = STATUS[r.status] ?? STATUS.hr_approved;
  const expense = r.expense && r.expense.status !== "voided" ? r.expense : null;
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap gap-2">
          <Badge tone={st.tone}>{st.label}</Badge>
          {r.requestedAmount != null && <Badge tone="warning">Amount changed by finance</Badge>}
        </div>
        <ClaimFacts r={r} />
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-foreground-muted">
          {r.status === "paid" && (
            <span>
              Paid{r.paidOn ? <> on <span className="text-foreground">{day(r.paidOn)}</span></> : null}
              {r.paymentMethod ? <> by <span className="text-foreground">{methodLabel(r.paymentMethod)}</span></> : null}
              {r.financeReviewedBy ? <> · <span className="text-foreground">{r.financeReviewedBy}</span></> : null}
              {expense ? <> — <Link href={`/expenses/${expense.id}`} className="font-medium text-primary hover:underline">{expense.expenseNumber}</Link></>
                : r.financeRef ? <> — <span className="text-foreground">{r.financeRef}</span></> : null}
            </span>
          )}
          {r.status === "rejected" && r.financeReviewedAt && (
            <span>Refused on <span className="text-foreground">{day(r.financeReviewedAt)}</span>{r.financeReviewedBy ? <> by <span className="text-foreground">{r.financeReviewedBy}</span></> : null}</span>
          )}
          {r.financeNote && <span>Finance&apos;s note: <span className="text-foreground">{r.financeNote}</span></span>}
        </div>
      </div>
      <div className="shrink-0 sm:text-right">
        <MoneyDisplay minor={Math.round(r.amount * 100)} currency={(r.currency || "AED").toUpperCase()} className="text-base font-semibold" />
        {r.requestedAmount != null && (
          <p className="text-xs text-foreground-muted">of <MoneyDisplay minor={Math.round(r.requestedAmount * 100)} currency={(r.currency || "AED").toUpperCase()} /> claimed</p>
        )}
      </div>
    </div>
  );
}

// ── One claim waiting on finance ──────────────────────────────────────────────

function ClaimCard({ claim: r }: { claim: WaitingClaim }) {
  const categories = useExpenseCategories();
  const departments = useAllDepartments();
  const pay = usePayReimbursement();
  const reject = useRejectReimbursement();

  const [department, setDepartment] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [payout, setPayout] = useState<Payout>(emptyPayout);
  // What is paid (2026-11-16) — the amount claimed unless finance changes it; HRMS shows both.
  const [amountText, setAmountText] = useState(() => r.amount.toFixed(2));

  const categoryList = categories.data ?? [];
  // Employee Reimbursements, its subcategory from the claim's category (food → Staff Meals, phone → Mobile Expenses).
  const cat = useCategoryChoice(categoryList, { category: EXPENSE_DEFAULTS.reimbursement.category, subcategory: r.suggestedSubcategory });
  const departmentList = departments.data ?? [];
  const suggested = r.suggestedDepartmentId && departmentList.some((d) => d.id === r.suggestedDepartmentId) ? r.suggestedDepartmentId : NO_DEPARTMENT;
  const chosenDepartment = department ?? suggested;
  const busy = pay.isPending || reject.isPending;
  const currency = (r.currency || "AED").toUpperCase();
  const reasonOk = note.trim().length >= 3;
  const claimedMinor = Math.round(r.amount * 100);
  const typed = Number(amountText);
  const paidMinor = amountText.trim() && Number.isFinite(typed) ? Math.round(typed * 100) : 0;
  const amountValid = paidMinor > 0;
  const changed = amountValid && paidMinor !== claimedMinor;
  const over = changed && paidMinor > claimedMinor;
  const needsReason = over && !note.trim();
  // An HRMS from before 2026-11-16 doesn't say requestedAmount and refuses a different amount.
  const canChange = "requestedAmount" in r;

  const made = r.expense && r.expense.status !== "voided" ? r.expense : null;
  const voided = r.expense?.status === "voided" ? r.expense : null;
  const id = (field: string) => `reimbursement-${r._id}-${field}`;

  const onPay = async () => {
    const res = await pay.mutateAsync({
      id: r._id,
      hrmsOrgId: r.hrmsOrgId,
      note: note.trim(),
      ...payout,
      ...(!made && changed ? { amountMinor: paidMinor } : {}),
      ...(made ? {} : { category: cat.value.category, subcategory: cat.value.subcategory || undefined, departmentId: chosenDepartment === NO_DEPARTMENT ? "" : chosenDepartment }),
    });
    toast.success(`Paid — ${res.expense.expenseNumber} recorded, and the claim shows Paid in HRMS`);
  };

  const onReject = async () => {
    await reject.mutateAsync({ id: r._id, hrmsOrgId: r.hrmsOrgId, note: note.trim() });
    toast.success("Refused — the employee has been told why");
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <ClaimFacts r={r} />
        <div className="shrink-0 sm:text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">Claimed</p>
          <MoneyDisplay minor={Math.round(r.amount * 100)} currency={currency} className="text-lg font-semibold" />
        </div>
      </div>

      {made && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            <Link href={`/expenses/${made.id}`} className="font-medium text-primary underline-offset-2 hover:underline">{made.expenseNumber}</Link>{" "}
            has been recorded for this claim, but HRMS has not been told yet. Send it again — no second expense is made.
          </span>
        </div>
      )}
      {voided && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <span>{voided.expenseNumber} was recorded for this claim and then voided. Refuse it instead.</span>
        </div>
      )}

      <div className="space-y-4 border-t border-border bg-surface-muted/50 p-5">
        {!made && !voided && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={id("amount")}>Amount paid ({currency})</Label>
              <Input id={id("amount")} type="number" inputMode="decimal" min={0.01} step="0.01" value={amountText}
                disabled={!canChange} onChange={(e) => setAmountText(e.target.value)} aria-invalid={!amountValid || needsReason} />
              <p className={`text-xs ${!amountValid || needsReason ? "text-danger" : changed ? "text-warning" : "text-foreground-muted"}`}>
                {!canChange
                  ? "HRMS needs updating before the amount can be changed."
                  : !amountValid
                    ? "Enter the amount paid."
                    : changed
                      ? <>Changed — claimed <MoneyDisplay minor={claimedMinor} currency={currency} />{over ? ". More than claimed: say why in the note." : ". The employee sees both in HRMS."}</>
                      : "What was claimed. Change it if a different amount is paid."}
              </p>
            </div>
            <PayoutFields value={payout} onChange={setPayout} idPrefix={id("payout")} />
            <CategoryPicker categories={categoryList} value={cat.value} onChange={cat.set} idPrefix={id("expense")} loading={categories.isLoading} />
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
            <Label htmlFor={id("note")}>{over ? "Note — say why more than claimed is paid" : "Note — needed to refuse"}</Label>
            <Input id={id("note")} value={note} maxLength={500} placeholder="The employee sees it with the decision"
              onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex shrink-0 gap-2">
            {!voided && (
              <Button onClick={() => void onPay().catch(() => undefined)} disabled={busy || (!made && (!cat.complete || !payoutValid(payout) || !amountValid || needsReason))}>
                {pay.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : made ? <Send className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                {made ? "Send to HRMS" : <>Approve and pay{amountValid ? <> <MoneyDisplay minor={paidMinor} currency={currency} /></> : null}</>}
              </Button>
            )}
            <Button variant="outline" onClick={() => void onReject().catch(() => undefined)} disabled={busy || !!made || !reasonOk}
              title={made ? `Void ${made.expenseNumber} before refusing` : !reasonOk ? "Write why in the note first" : undefined}>
              {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}Refuse
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
