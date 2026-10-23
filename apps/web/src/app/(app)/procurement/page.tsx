"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ClipboardList, Check, X, Loader2, Send, AlertTriangle, Paperclip, Search } from "lucide-react";
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
  useProcurementRequests, useProcurementHistory, useApproveProcurement, useRejectProcurement,
  type ProcurementRequest, type ProcurementRecord,
} from "@/features/procurement/api";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { CategoryPicker, useCategoryChoice } from "@/features/expense-categories/CategoryPicker";
import { useAllDepartments } from "@/features/departments/api";

/** Radix reads "" as unset, so "no department" needs a value of its own. */
const NO_DEPARTMENT = "__none__";

/**
 * What HR has approved and finance has not yet decided.
 *
 * Approving records an expense — approved, unpaid — so what is asked for is
 * what an expense needs and HR could not know: the amount being agreed to (HR's
 * is an estimate, and sometimes blank), the expense category, and the
 * department it counts against. The vendor is not asked: most of these are
 * bought before anybody picks one, and "Mark paid" on the expense records how
 * it was actually paid.
 */
type Tab = "waiting" | "all";

/**
 * Two tabs, kept in the URL (?tab=all): what waits on finance — decided here — and every procurement request from
 * HRMS (the user, 2026-10-23): still with HR, waiting, approved, ordered, received, refused, cancelled, and what was
 * already bought, with filters and totals.
 */
export default function ProcurementPage() {
  const { data: requests, isLoading, error } = useProcurementRequests();
  const rows = requests ?? [];
  const [tab, setTabState] = useState<Tab>("waiting");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "all") setTabState("all");
  }, []);
  const setTab = (t: Tab) => {
    setTabState(t);
    const p = new URLSearchParams(window.location.search);
    if (t === "waiting") p.delete("tab"); else p.set("tab", t);
    window.history.replaceState(null, "", `${window.location.pathname}${p.size ? `?${p}` : ""}`);
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        icon={ClipboardList}
        title="Procurement"
        description="Every purchase request from HRMS. Waiting: HR has approved them and they need the money decision — approving one records it as an expense. All: every request, whatever became of it."
        action={rows.length > 0 ? <Badge tone="warning">{rows.length} waiting</Badge> : undefined}
      />

      <div className="flex w-fit gap-1 rounded-lg border border-border bg-surface p-1 text-sm" role="tablist">
        {([["waiting", "Waiting"], ["all", "All procurement"]] as const).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`rounded-md px-3 py-1.5 font-medium ${tab === k ? "bg-primary text-primary-foreground" : "text-foreground-muted hover:bg-surface-muted"}`}
          >
            {label}
            {k === "waiting" && rows.length > 0 && <span className="ml-1.5 tabular-nums">({rows.length})</span>}
          </button>
        ))}
      </div>

      {tab === "all" ? <AllProcurement /> : isLoading ? (
        <Card className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-foreground-muted" />
        </Card>
      ) : error ? (
        <Card className="px-5 py-12 text-center text-sm text-foreground-muted">
          <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" />
          Could not reach HRMS. Check the integration settings and try again.
        </Card>
      ) : !rows.length ? (
        <Card className="px-5 py-16 text-center text-sm text-foreground-muted">
          <ClipboardList className="mx-auto mb-3 h-8 w-8 opacity-40" />
          Nothing is waiting for a decision.
        </Card>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => <RequestCard key={`${r.hrmsOrgId}:${r._id}`} request={r} />)}
        </div>
      )}
    </div>
  );
}

// ── Every request (2026-10-23) ───────────────────────────────────────────────

const STATUS: Record<ProcurementRecord["status"], { label: string; tone: "neutral" | "primary" | "warning" | "success" | "danger" }> = {
  requested: { label: "With HR", tone: "neutral" },
  hr_approved: { label: "Waiting on finance", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  ordered: { label: "Ordered", tone: "primary" },
  received: { label: "Received", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
const ALL = "__all__";
const day = (v?: string | null) => (v ? String(v).slice(0, 10) : "");

function AllProcurement() {
  const { data, isLoading, error } = useProcurementHistory("all");
  const [status, setStatus] = useState<string>(ALL);
  const [kind, setKind] = useState<string>(ALL);
  const [dept, setDept] = useState<string>(ALL);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const all = data ?? [];
  const departments = useMemo(
    () => [...new Set(all.map((r) => r.department?.name).filter((n): n is string => !!n))].sort((a, b) => a.localeCompare(b)),
    [all],
  );
  const needle = q.trim().toLowerCase();
  // Everything but the status, so each status's total shows what picking it would give.
  const filtered = useMemo(() => all.filter((r) =>
    (kind === ALL || r.kind === kind)
    && (dept === ALL || r.department?.name === dept)
    && (!from || day(r.createdAt) >= from)
    && (!to || day(r.createdAt) <= to)
    && (!needle || [r.item, r.category, r.vendor, r.requestedBy?.name, r.justification, r.expense?.expenseNumber].some((v) => String(v ?? "").toLowerCase().includes(needle)))), [all, kind, dept, from, to, needle]);
  const shown = status === ALL ? filtered : filtered.filter((r) => r.status === status);

  const totals = useMemo(() => {
    const by = new Map<string, { count: number; minor: Map<string, number> }>();
    for (const r of filtered) {
      const t = by.get(r.status) ?? { count: 0, minor: new Map<string, number>() };
      t.count += 1;
      t.minor.set(r.currency, (t.minor.get(r.currency) ?? 0) + Math.round((r.estimatedCost || 0) * 100));
      by.set(r.status, t);
    }
    return by;
  }, [filtered]);
  const shownMinor = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of shown) m.set(r.currency, (m.get(r.currency) ?? 0) + Math.round((r.estimatedCost || 0) * 100));
    return [...m.entries()].filter(([, v]) => v > 0);
  }, [shown]);

  const message = error instanceof ApiError
    ? error.status === 404 ? "The finance API needs updating before it can show this." : error.message
    : "Could not reach HRMS. Check the integration settings and try again.";
  const busy = status !== ALL || kind !== ALL || dept !== ALL || q || from || to;

  if (isLoading) return <Card className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>;
  if (error) return (
    <Card className="px-5 py-12 text-center text-sm text-foreground-muted">
      <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" />
      {message}
    </Card>
  );

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setStatus(ALL)}
          className={`rounded-full border px-3 py-1 text-sm font-medium ${status === ALL ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface hover:bg-surface-muted"}`}>
          All <span className="tabular-nums opacity-80">{filtered.length}</span>
        </button>
        {(Object.keys(STATUS) as ProcurementRecord["status"][]).map((k) => {
          const t = totals.get(k);
          return (
            <button key={k} type="button" onClick={() => setStatus(status === k ? ALL : k)}
              className={`rounded-full border px-3 py-1 text-sm font-medium ${status === k ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface hover:bg-surface-muted"}`}>
              {STATUS[k].label} <span className="tabular-nums opacity-80">{t?.count ?? 0}</span>
            </button>
          );
        })}
      </div>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[200px] flex-1 space-y-1.5">
          <Label htmlFor="proc-q" className="text-xs text-foreground-muted">Search</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted" />
            <Input id="proc-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Item, vendor, who asked, expense number…" className="pl-9" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-foreground-muted">Kind</Label>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All kinds</SelectItem>
              <SelectItem value="new">New request</SelectItem>
              <SelectItem value="existing">Already bought</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-foreground-muted">HRMS department</Label>
          <Select value={dept} onValueChange={setDept}>
            <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All departments</SelectItem>
              {departments.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="proc-from" className="text-xs text-foreground-muted">Raised from</Label>
          <Input id="proc-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="proc-to" className="text-xs text-foreground-muted">To</Label>
          <Input id="proc-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
        </div>
        {busy && (
          <Button variant="ghost" onClick={() => { setStatus(ALL); setKind(ALL); setDept(ALL); setQ(""); setFrom(""); setTo(""); }}>
            <X className="h-4 w-4" />Clear
          </Button>
        )}
      </Card>

      <p className="text-sm text-foreground-muted">
        {shown.length} request{shown.length === 1 ? "" : "s"}
        {shownMinor.length > 0 && <> · estimated {shownMinor.map(([c, m], i) => <span key={c}>{i > 0 && " + "}<MoneyDisplay minor={m} currency={c} className="font-semibold text-foreground" /></span>)}</>}
      </p>

      {!shown.length ? (
        <Card className="px-5 py-10 text-center text-sm text-foreground-muted">{all.length ? "Nothing matches these filters." : "No procurement in HRMS yet."}</Card>
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {shown.map((r) => <RecordRow key={`${r.hrmsOrgId}:${r._id}`} r={r} />)}
        </Card>
      )}
    </section>
  );
}

function RecordRow({ r }: { r: ProcurementRecord }) {
  const st = STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
  const hrRefused = r.status === "rejected" && r.rejectedBy === "hr";
  const financeRefused = r.status === "rejected" && r.rejectedBy === "finance";
  const expense = r.expense && r.expense.status !== "voided" ? r.expense : null;
  const facts = [r.category, r.department?.name, r.vendor ? `Vendor: ${r.vendor}` : null].filter(Boolean);

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{r.quantity} × {r.item}</h3>
          <Badge tone={st.tone}>{hrRefused ? "Rejected by HR" : financeRefused ? "Rejected by finance" : st.label}</Badge>
          {r.kind === "existing" && <Badge>Already bought</Badge>}
          {r.resubmitCount > 0 && <Badge tone="warning">Resubmitted ×{r.resubmitCount}</Badge>}
          {r.reportUrl && (
            <a href={r.reportUrl} target="_blank" rel="noopener noreferrer" className="text-foreground-muted hover:text-primary" title="Attached document">
              <Paperclip className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
        {facts.length > 0 && <p className="text-sm capitalize text-foreground-muted">{facts.join(" · ")}</p>}
        {r.justification && <p className="text-sm">{r.justification}</p>}
        <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-xs text-foreground-muted">
          <span>Raised <span className="text-foreground">{day(r.createdAt)}</span>{r.requestedBy?.name ? <> by <span className="text-foreground">{r.requestedBy.name}</span></> : null}</span>
          {r.neededBy && <span>Needed by <span className="text-foreground">{day(r.neededBy)}</span></span>}
          {r.hrReviewedBy?.name && r.status !== "requested" && r.kind === "new" && (
            <span>{hrRefused ? "Refused" : "Approved"} by HR: <span className="text-foreground">{r.hrReviewedBy.name}</span>{r.hrReviewedAt ? `, ${day(r.hrReviewedAt)}` : ""}</span>
          )}
          {r.hrNote && <span>HR&apos;s note: <span className="text-foreground">{r.hrNote}</span></span>}
          {r.financeReviewedAt && <span>{financeRefused ? "Refused" : "Decided"} by finance on <span className="text-foreground">{day(r.financeReviewedAt)}</span></span>}
          {r.financeNote && <span>Finance&apos;s note: <span className="text-foreground">{r.financeNote}</span></span>}
          {expense ? (
            <span>Expense <Link href={`/expenses/${expense.id}`} className="font-medium text-primary hover:underline">{expense.expenseNumber}</Link> ({expense.status})</span>
          ) : r.purchaseOrderRef ? <span>Reference <span className="text-foreground">{r.purchaseOrderRef}</span></span> : null}
        </div>
      </div>
      <div className="shrink-0 space-y-0.5 sm:text-right">
        {r.estimatedCost > 0
          ? <MoneyDisplay minor={Math.round(r.estimatedCost * 100)} currency={r.currency} className="text-base font-semibold" />
          : <span className="text-sm text-foreground-muted">No estimate</span>}
        {expense?.totalMinor != null && <p className="text-xs text-foreground-muted">Approved <MoneyDisplay minor={expense.totalMinor} currency={r.currency} /></p>}
      </div>
    </div>
  );
}

function RequestCard({ request: r }: { request: ProcurementRequest }) {
  const categories = useExpenseCategories();
  const departments = useAllDepartments();
  const approve = useApproveProcurement();
  const reject = useRejectProcurement();

  const [amount, setAmount] = useState(r.estimatedCost > 0 ? String(r.estimatedCost) : "");
  const [categoryOther, setCategoryOther] = useState(r.category ?? "");
  const [department, setDepartment] = useState<string | null>(null);
  const [note, setNote] = useState("");

  // Defaults wait for the lists they come from: Other / Unclassified › Pending
  // Classification when this org has it (2026-10-21), and the finance
  // department HR's is linked to, when that still exists.
  const categoryList = categories.data ?? [];
  const cat = useCategoryChoice(categoryList, EXPENSE_DEFAULTS.procurement);
  const chosenCategory = cat.value.category;
  const departmentList = departments.data ?? [];
  const suggested = r.suggestedDepartmentId && departmentList.some((d) => d.id === r.suggestedDepartmentId)
    ? r.suggestedDepartmentId : NO_DEPARTMENT;
  const chosenDepartment = department ?? suggested;

  const amountMinor = Math.round(Number(amount) * 100);
  const amountValid = amount.trim() !== "" && Number.isFinite(amountMinor) && amountMinor > 0;
  const busy = approve.isPending || reject.isPending;

  // An expense already recorded for this request stands as it was made; all
  // that is left is telling HR — or, once voided, turning the request down.
  const made = r.expense && r.expense.status !== "voided" ? r.expense : null;
  const voided = r.expense?.status === "voided" ? r.expense : null;
  const id = (field: string) => `procurement-${r._id}-${field}`;

  const onApprove = async () => {
    const res = await approve.mutateAsync({
      id: r._id,
      hrmsOrgId: r.hrmsOrgId,
      note: note.trim(),
      // An expense already recorded is resent as it was made; these only make a new one.
      ...(made ? {} : {
        amountMinor,
        category: chosenCategory,
        subcategory: cat.value.subcategory || undefined,
        categoryOther: chosenCategory === "other" ? categoryOther.trim() : "",
        departmentId: chosenDepartment === NO_DEPARTMENT ? "" : chosenDepartment,
      }),
    });
    toast.success(`Approved — ${res.expense.expenseNumber} recorded, and HR has been told`);
  };

  const onReject = async () => {
    await reject.mutateAsync({ id: r._id, hrmsOrgId: r.hrmsOrgId, note: note.trim() });
    toast.success("Rejected — HR has been told");
  };

  const facts = [
    r.department?.name,
    r.requestedBy?.name ? `Asked by ${r.requestedBy.name}` : null,
    r.neededBy ? `Needed by ${String(r.neededBy).slice(0, 10)}` : null,
  ].filter(Boolean);

  return (
    <Card className="overflow-hidden">
      {/* What was asked for */}
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{r.quantity} × {r.item}</h3>
            {r.resubmitCount > 0 && <Badge tone="warning">Resubmitted ×{r.resubmitCount}</Badge>}
          </div>
          {facts.length > 0 && <p className="text-sm text-foreground-muted">{facts.join(" · ")}</p>}
          {r.justification && <p className="text-sm">{r.justification}</p>}
          {(r.vendor || r.hrNote) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-xs text-foreground-muted">
              {r.vendor && <span>Suggested vendor: <span className="text-foreground">{r.vendor}</span></span>}
              {r.hrNote && <span>HR&apos;s note: <span className="text-foreground">{r.hrNote}</span></span>}
            </div>
          )}
        </div>
        <div className="shrink-0 sm:text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">HR&apos;s estimate</p>
          {r.estimatedCost > 0 ? (
            <MoneyDisplay minor={Math.round(r.estimatedCost * 100)} currency={r.currency} className="text-lg font-semibold" />
          ) : (
            <p className="text-sm font-medium text-warning">None given</p>
          )}
        </div>
      </div>

      {made && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>
            <Link href={`/expenses/${made.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
              {made.expenseNumber}
            </Link>{" "}
            has been recorded for this request, but HR has not been told yet. Approve again to send it — no second
            expense is made.
          </span>
        </div>
      )}
      {voided && (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <span>
            {voided.expenseNumber} was recorded for this request and then voided. Reject it instead — HR can revise it
            and send it back.
          </span>
        </div>
      )}

      {/* The decision */}
      <div className="space-y-4 border-t border-border bg-surface-muted/50 p-5">
        {!made && !voided && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor={id("amount")}>Amount ({r.currency})</Label>
              <Input
                id={id("amount")} type="number" inputMode="decimal" min="0" step="0.01" value={amount} placeholder="0.00"
                aria-invalid={amount !== "" && !amountValid}
                onChange={(e) => setAmount(e.target.value)}
              />
              {!amountValid && (
                <p className={r.estimatedCost > 0 ? "text-xs text-foreground-muted" : "text-xs text-warning"}>
                  {r.estimatedCost > 0 ? "Enter an amount above 0." : "HR gave no estimate — enter the amount being approved."}
                </p>
              )}
            </div>
            <CategoryPicker categories={categoryList} value={cat.value} onChange={cat.set} idPrefix={id("expense")} loading={categories.isLoading} />
            {chosenCategory === "other" && (
              <div className="space-y-1.5">
                <Label htmlFor={id("other")}>What it is</Label>
                <Input id={id("other")} value={categoryOther} maxLength={60} placeholder="e.g. Office equipment"
                  onChange={(e) => setCategoryOther(e.target.value)} />
              </div>
            )}
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
            <Label htmlFor={id("note")}>Note to HR (optional)</Label>
            <Input id={id("note")} value={note} maxLength={500} placeholder="Sent back to HR with the decision"
              onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex shrink-0 gap-2">
            {!voided && (
              <Button
                onClick={() => void onApprove().catch(() => undefined)}
                disabled={busy || (!made && (!amountValid || !cat.complete))}
              >
                {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : made ? <Send className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                {made ? "Send approval to HR" : "Approve as expense"}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => void onReject().catch(() => undefined)}
              disabled={busy || !!made}
              title={made ? `Void ${made.expenseNumber} before rejecting` : undefined}
            >
              {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}Reject
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
