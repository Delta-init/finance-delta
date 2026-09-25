"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, WalletCards } from "lucide-react";
import type { BudgetAllocation, BudgetSummaryRow, FundingRequest } from "@delta/shared";
import { toMinor } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useCan } from "@/lib/use-can";
import { useCurrency } from "@/lib/currency-context";
import { useAllDepartments } from "@/features/departments/api";
import { useBudgetAllocations, useBudgetSummary, useCreateFundingRequest, useFundingRequests, useReviewFundingRequest, useSaveBudgetAllocation } from "@/features/budgets/api";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

const now = new Date();
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const getError = (error: unknown, fallback: string) => error instanceof ApiError ? error.message : fallback;
const periodLabel = (period: string) => {
  const [y, m] = period.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
};
const SOURCE_LABELS: Record<string, string> = { "media-erp": "Media ERP" };
const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? source;

function AllocationDialog({
  open, onOpenChange, initial, departmentId, period, currency, departments, history,
}: {
  open: boolean; onOpenChange: (open: boolean) => void; initial?: BudgetSummaryRow;
  departmentId?: string; period: string; currency: string; departments: { id: string; name: string }[];
  history: BudgetAllocation["changes"];
}) {
  const save = useSaveBudgetAllocation();
  const [dept, setDept] = useState(initial?.departmentId ?? departmentId ?? "");
  const [month, setMonth] = useState(initial?.period ?? period);
  const [ccy, setCcy] = useState(initial?.currency ?? currency);
  const [amount, setAmount] = useState(initial ? (initial.allocatedMinor / 100).toFixed(2) : "");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!open) return;
    setDept(initial?.departmentId ?? departmentId ?? "");
    setMonth(initial?.period ?? period);
    setCcy(initial?.currency ?? currency);
    setAmount(initial ? (initial.allocatedMinor / 100).toFixed(2) : "");
    setNote("");
  }, [open, initial, departmentId, period, currency]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dept || !month || !amount || Number(amount) < 0) return;
    try {
      await save.mutateAsync({ departmentId: dept, period: month, currency: ccy.toUpperCase(), allocatedMinor: toMinor(amount), note });
      toast.success("Monthly allocation saved"); onOpenChange(false);
    } catch (e) { toast.error(getError(e, "Could not save the allocation")); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>Monthly department allocation</DialogTitle><DialogDescription>Set the approved budget amount for one department and month. Every change is recorded.</DialogDescription></DialogHeader>
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5"><Label>Department</Label><Select value={dept} onValueChange={setDept}><SelectTrigger><SelectValue placeholder="Choose department" /></SelectTrigger><SelectContent>{departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent></Select></div>
      <div className="grid grid-cols-2 gap-3"><div className="space-y-1.5"><Label>Month</Label><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} required /></div><div className="space-y-1.5"><Label>Currency</Label><Input value={ccy} maxLength={3} onChange={(e) => setCcy(e.target.value.toUpperCase())} required /></div></div>
      <div className="space-y-1.5"><Label>Allocation amount</Label><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required /></div>
      <div className="space-y-1.5"><Label>Change note</Label><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for setting or changing this allocation" maxLength={500} /></div>
      {history.length > 0 && <div className="rounded-lg border border-border p-3"><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">Recent allocation changes</p><div className="max-h-32 space-y-2 overflow-y-auto">{history.slice(-5).reverse().map((change, index) => <div key={`${change.changedAt}-${index}`} className="flex justify-between gap-3 text-xs"><span className="min-w-0"><span className="font-medium">{change.changedByName}</span>{change.note && <span className="block truncate text-foreground-muted">{change.note}</span>}</span><span className="shrink-0 text-right text-foreground-muted"><MoneyDisplay minor={change.allocatedMinor} currency={ccy} /><span className="block">{new Date(change.changedAt).toLocaleDateString()}</span></span></div>)}</div></div>}
      <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={save.isPending} disabled={!dept || !month || !amount}>Save allocation</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

function FundingRequestDialog({ open, onOpenChange, currency, defaultPeriod }: { open: boolean; onOpenChange: (open: boolean) => void; currency: string; defaultPeriod: string }) {
  const create = useCreateFundingRequest();
  const [period, setPeriod] = useState(defaultPeriod);
  const [amount, setAmount] = useState("");
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  useEffect(() => { if (open) { setPeriod(defaultPeriod); setAmount(""); setTitle(""); setPurpose(""); } }, [open, defaultPeriod]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await create.mutateAsync({ period, amountMinor: toMinor(amount), title, purpose, currency });
      toast.success("Funding request submitted"); onOpenChange(false); setAmount(""); setTitle(""); setPurpose("");
    } catch (e) { toast.error(getError(e, "Could not submit the funding request")); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>Request department funds</DialogTitle><DialogDescription>Request an additional amount for a specific month. Finance will review it before it changes available funds.</DialogDescription></DialogHeader>
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3"><div className="space-y-1.5"><Label>Requested month</Label><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required /></div><div className="space-y-1.5"><Label>Amount ({currency})</Label><Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div></div>
      <div className="space-y-1.5"><Label>Request title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={120} placeholder="e.g. Campaign production costs" required /></div>
      <div className="space-y-1.5"><Label>Business purpose</Label><Textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} minLength={10} maxLength={2000} rows={5} placeholder="Explain why the additional funds are needed and how they will be used." required /></div>
      <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" loading={create.isPending} disabled={!period || !amount || !title || purpose.trim().length < 10}>Submit request</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

function ReviewDialog({ request, onClose }: { request: FundingRequest | null; onClose: () => void }) {
  const review = useReviewFundingRequest(request?.id ?? "");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [note, setNote] = useState("");
  useEffect(() => { if (request) { setDecision("approved"); setNote(""); } }, [request?.id]);
  // A drawdown spends the department's allocation, so show what is left of it
  // for that month — the same figure the server refuses an approval on.
  const drawdown = request?.kind === "drawdown";
  const { data: balanceResult, isLoading: balanceLoading } = useBudgetSummary(
    request ? { year: Number(request.period.slice(0, 4)), month: request.period, departmentId: request.departmentId } : {},
    !!request && drawdown,
  );
  const available = balanceResult?.data?.find((row) => row.currency === request?.currency)?.availableMinor ?? 0;
  const overBudget = !!request && drawdown && !balanceLoading && request.amountMinor > available;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!request) return;
    if (decision === "rejected" && note.trim().length < 5) { toast.error("Add a short reason before rejecting"); return; }
    try { await review.mutateAsync({ decision, note }); toast.success(decision === "approved" ? "Funding request approved" : "Funding request rejected"); onClose(); }
    catch (e) { toast.error(getError(e, "Could not review this request")); }
  };
  return <Dialog open={!!request} onOpenChange={(open) => !open && onClose()}><DialogContent>
    <DialogHeader><DialogTitle>Review funding request</DialogTitle><DialogDescription>{request ? `${request.departmentName} · ${periodLabel(request.period)} · ${request.title}` : ""}</DialogDescription></DialogHeader>
    {request && <div className="rounded-lg bg-surface-muted p-3 text-sm"><p className="font-medium">Requested by {request.requestedByName}{request.source !== "finance" && <span className="font-normal text-foreground-muted"> · {sourceLabel(request.source)}</span>}</p>{request.requestedByEmail && <p className="text-xs text-foreground-muted">{request.requestedByEmail}</p>}{request.platform && <p className="mt-1 text-xs text-foreground-muted">Platform: <span className="font-medium text-foreground">{request.platform}</span></p>}<p className="mt-2 whitespace-pre-wrap text-foreground-muted">{request.purpose}</p><p className="mt-3 font-semibold"><MoneyDisplay minor={request.amountMinor} currency={request.currency} />{drawdown && <span className="ml-2 text-xs font-normal text-foreground-muted">drawn from the {periodLabel(request.period)} allocation</span>}</p>
      {drawdown && <div className={`mt-3 rounded-md border px-3 py-2 text-xs ${overBudget ? "border-red-500/30 bg-red-500/5 text-red-700" : "border-border text-foreground-muted"}`}>{balanceLoading ? "Checking what is left…" : <>{request.departmentName} has <MoneyDisplay minor={available} currency={request.currency} /> left for {periodLabel(request.period)}.{overBudget ? " This request is more than that — raise the allocation first, or reject it." : <> After this request: <MoneyDisplay minor={available - request.amountMinor} currency={request.currency} />.</>}</>}</div>}
    </div>}
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5"><Label>Decision</Label><Select value={decision} onValueChange={(v) => setDecision(v as "approved" | "rejected")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="approved">Approve</SelectItem><SelectItem value="rejected">Reject</SelectItem></SelectContent></Select></div>
      <div className="space-y-1.5"><Label>{decision === "rejected" ? "Reason (required)" : "Review note (optional)"}</Label><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} /></div>
      <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant={decision === "rejected" ? "destructive" : "primary"} loading={review.isPending} disabled={decision === "approved" && (overBudget || (drawdown && balanceLoading))}>{decision === "approved" ? "Approve funds" : "Reject request"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

function StatusPill({ status }: { status: FundingRequest["status"] }) {
  const styles = status === "approved" ? "bg-emerald-500/10 text-emerald-700" : status === "rejected" ? "bg-red-500/10 text-red-700" : "bg-amber-500/10 text-amber-700";
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${styles}`}>{status}</span>;
}

export default function BudgetsPage() {
  const can = useCan();
  const { baseCurrency } = useCurrency();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(thisMonth);
  const [requestOpen, setRequestOpen] = useState(false);
  const [allocationOpen, setAllocationOpen] = useState(false);
  const [allocationTarget, setAllocationTarget] = useState<BudgetSummaryRow | undefined>();
  const [reviewTarget, setReviewTarget] = useState<FundingRequest | null>(null);
  const [deptFilter, setDeptFilter] = useState("all");
  const { data: departments = [] } = useAllDepartments();
  const query = { year: Number(year), month: month === "all" ? undefined : month, departmentId: deptFilter === "all" ? undefined : deptFilter };
  const { data: summaryResult, isLoading: summaryLoading } = useBudgetSummary(query);
  const { data: allocationsResult } = useBudgetAllocations({ year: Number(year), departmentId: deptFilter === "all" ? undefined : deptFilter }, can.can("budget:manage"));
  const { data: requestsResult, isLoading: requestsLoading } = useFundingRequests(query);
  const summary = summaryResult?.data ?? [];
  const allocations = allocationsResult?.data ?? [];
  const requests = requestsResult?.data ?? [];
  const currentPeriod = month === "all" ? thisMonth.slice(0, 4) === year ? thisMonth : `${year}-01` : month;

  const rows = useMemo(() => {
    const map = new Map<string, BudgetSummaryRow>();
    for (const row of summary) map.set(`${row.departmentId}|${row.period}|${row.currency}`, row);
    for (const row of allocations) {
      if (month !== "all" && row.period !== month) continue;
      const key = `${row.departmentId}|${row.period}|${row.currency}`;
      const current = map.get(key);
      if (current) current.allocatedMinor = row.allocatedMinor;
      else map.set(key, { departmentId: row.departmentId, departmentName: row.departmentName, period: row.period, currency: row.currency, allocatedMinor: row.allocatedMinor, approvedRequestsMinor: 0, approvedDrawdownsMinor: 0, approvedExpensesMinor: 0, availableMinor: row.allocatedMinor, pendingRequests: 0 });
    }
    if (month !== "all" && can.can("budget:manage")) {
      for (const department of departments) {
        if (deptFilter !== "all" && deptFilter !== department.id) continue;
        const key = `${department.id}|${month}|${baseCurrency}`;
        if (!map.has(key)) map.set(key, { departmentId: department.id, departmentName: department.name, period: month, currency: baseCurrency, allocatedMinor: 0, approvedRequestsMinor: 0, approvedDrawdownsMinor: 0, approvedExpensesMinor: 0, availableMinor: 0, pendingRequests: 0 });
      }
    }
    return [...map.values()].filter((row) => deptFilter === "all" || row.departmentId === deptFilter).sort((a, b) => a.period.localeCompare(b.period) || a.departmentName.localeCompare(b.departmentName) || a.currency.localeCompare(b.currency));
  }, [summary, allocations, month, departments, deptFilter, can, baseCurrency]);

  const currencyTotals = useMemo(() => {
    const grouped = new Map<string, { allocation: number; additions: number; drawn: number; expenses: number; available: number }>();
    for (const row of summary) {
      const sum = grouped.get(row.currency) ?? { allocation: 0, additions: 0, drawn: 0, expenses: 0, available: 0 };
      sum.allocation += row.allocatedMinor; sum.additions += row.approvedRequestsMinor; sum.drawn += row.approvedDrawdownsMinor; sum.expenses += row.approvedExpensesMinor; sum.available += row.availableMinor;
      grouped.set(row.currency, sum);
    }
    return [...grouped.entries()];
  }, [summary]);

  const openAllocation = (row?: BudgetSummaryRow) => { setAllocationTarget(row); setAllocationOpen(true); };
  const closeAllocation = (open: boolean) => { setAllocationOpen(open); if (!open) setAllocationTarget(undefined); };

  return <div className="space-y-6 p-6">
    <PageHeader icon={WalletCards} title="Budgets & Funds" description="Set monthly department allocations, review additional funding requests, and track approved expenses." action={can.can("budget:request") ? <Button onClick={() => setRequestOpen(true)}><Plus className="h-4 w-4" />Request funds</Button> : undefined} />

    <Card className="flex flex-wrap items-end gap-3 p-4">
      <div className="space-y-1.5"><Label className="text-xs">Calendar year</Label><Select value={year} onValueChange={(value) => { setYear(value); if (month !== "all") setMonth(`${value}-${month.slice(5)}`); }}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent>{Array.from({ length: 7 }, (_, i) => now.getFullYear() - 3 + i).map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-1.5"><Label className="text-xs">Month</Label><Select value={month} onValueChange={setMonth}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Full year</SelectItem>{MONTHS.map((label, index) => <SelectItem key={index} value={`${year}-${String(index + 1).padStart(2, "0")}`}>{label}</SelectItem>)}</SelectContent></Select></div>
      {can.can("budget:read") && <div className="space-y-1.5"><Label className="text-xs">Department</Label><Select value={deptFilter} onValueChange={setDeptFilter}><SelectTrigger className="w-52"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All departments</SelectItem>{departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent></Select></div>}
      {can.can("budget:manage") && <Button variant="outline" className="ml-auto" onClick={() => openAllocation()}><Plus className="h-4 w-4" />Set allocation</Button>}
    </Card>

    {summaryLoading ? <div className="py-16 text-center text-sm text-foreground-muted">Loading budget data…</div> : currencyTotals.length > 0 && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {currencyTotals.map(([currency, total]) => <Card key={currency} className="p-4"><p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">{month === "all" ? `${year} · ${currency}` : `${periodLabel(month)} · ${currency}`}</p><p className="mt-1 text-xl font-semibold"><MoneyDisplay minor={total.available} currency={currency} /></p><p className="mt-1 text-xs text-foreground-muted">Available · <MoneyDisplay minor={total.allocation} currency={currency} /> allocated · <MoneyDisplay minor={total.additions} currency={currency} /> top-ups · <MoneyDisplay minor={total.drawn} currency={currency} /> drawn · <MoneyDisplay minor={total.expenses} currency={currency} /> approved expenses</p></Card>)}
    </div>}

    <section className="space-y-3"><div className="flex items-center justify-between"><div><h2 className="text-base font-semibold">Department allocations</h2><p className="text-sm text-foreground-muted">Available = monthly allocation + approved top-ups − approved drawdowns − approved expenses.</p></div></div>
      <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full min-w-[960px] text-sm"><thead><tr className="border-b bg-surface-muted/60 text-left text-xs uppercase tracking-wide text-foreground-muted"><th className="px-4 py-3">Department</th><th className="px-4 py-3">Period</th><th className="px-4 py-3">Currency</th><th className="px-4 py-3 text-right">Allocated</th><th className="px-4 py-3 text-right">Top-ups</th><th className="px-4 py-3 text-right">Drawn</th><th className="px-4 py-3 text-right">Approved expenses</th><th className="px-4 py-3 text-right">Available</th>{can.can("budget:manage") && <th className="px-4 py-3 text-right">Action</th>}</tr></thead><tbody className="divide-y divide-border">
        {rows.length === 0 ? <tr><td colSpan={can.can("budget:manage") ? 9 : 8} className="px-4 py-12 text-center text-foreground-muted">No budget or expense activity for this period.</td></tr> : rows.map((row) => <tr key={`${row.departmentId}-${row.period}-${row.currency}`} className="hover:bg-surface-muted/40"><td className="px-4 py-3 font-medium">{row.departmentName}</td><td className="px-4 py-3 text-foreground-muted">{periodLabel(row.period)}</td><td className="px-4 py-3">{row.currency}</td><td className="px-4 py-3 text-right"><MoneyDisplay minor={row.allocatedMinor} currency={row.currency} /></td><td className="px-4 py-3 text-right"><MoneyDisplay minor={row.approvedRequestsMinor} currency={row.currency} /></td><td className="px-4 py-3 text-right"><MoneyDisplay minor={row.approvedDrawdownsMinor} currency={row.currency} /></td><td className="px-4 py-3 text-right"><MoneyDisplay minor={row.approvedExpensesMinor} currency={row.currency} /></td><td className={`px-4 py-3 text-right font-semibold ${row.availableMinor < 0 ? "text-red-600" : ""}`}><MoneyDisplay minor={row.availableMinor} currency={row.currency} /></td>{can.can("budget:manage") && <td className="px-4 py-3 text-right"><Button size="sm" variant="ghost" onClick={() => openAllocation(row)}>{row.allocatedMinor ? "Adjust" : "Allocate"}</Button></td>}</tr>)}
      </tbody></table></div></Card>
    </section>

    <section className="space-y-3"><div><h2 className="text-base font-semibold">Funding requests</h2><p className="text-sm text-foreground-muted">An approved top-up adds to the department&apos;s month; an approved drawdown (from Media ERP) comes off it. Pending requests change nothing.</p></div>
      <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full min-w-[850px] text-sm"><thead><tr className="border-b bg-surface-muted/60 text-left text-xs uppercase tracking-wide text-foreground-muted"><th className="px-4 py-3">Department / request</th><th className="px-4 py-3">Period</th><th className="px-4 py-3">Requested by</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Review</th></tr></thead><tbody className="divide-y divide-border">
        {requestsLoading ? <tr><td colSpan={6} className="px-4 py-12 text-center text-foreground-muted">Loading requests…</td></tr> : requests.length === 0 ? <tr><td colSpan={6} className="px-4 py-12 text-center text-foreground-muted">No funding requests for this period.</td></tr> : requests.map((r) => <tr key={r.id} className="align-top hover:bg-surface-muted/40"><td className="px-4 py-3"><p className="font-medium">{r.departmentName} · {r.title}</p><div className="mt-1 flex flex-wrap gap-1.5">{r.kind === "drawdown" ? <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700">Drawdown</span> : <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Top-up</span>}{r.source !== "finance" && <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-700">{sourceLabel(r.source)}</span>}{r.platform && <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-foreground-muted">{r.platform}</span>}</div><p className="mt-1 max-w-md text-xs text-foreground-muted">{r.purpose}</p>{r.reviewNote && <p className="mt-1 text-xs text-foreground-muted">Review: {r.reviewNote}</p>}</td><td className="px-4 py-3 text-foreground-muted">{periodLabel(r.period)}</td><td className="px-4 py-3">{r.requestedByName}{r.requestedByEmail && <span className="block text-xs text-foreground-muted">{r.requestedByEmail}</span>}<span className="mt-1 block text-xs text-foreground-muted">{new Date(r.requestedAt).toLocaleDateString()}</span></td><td className="px-4 py-3 text-right font-medium"><MoneyDisplay minor={r.amountMinor} currency={r.currency} /></td><td className="px-4 py-3"><StatusPill status={r.status} /></td><td className="px-4 py-3 text-right">{can.can("budget:approve") && r.status === "submitted" ? <Button size="sm" variant="outline" onClick={() => setReviewTarget(r)}>Review</Button> : r.reviewedByName ? <span className="text-xs text-foreground-muted">Reviewed by {r.reviewedByName}</span> : <span className="text-xs text-foreground-muted">—</span>}</td></tr>)}
      </tbody></table></div></Card>
    </section>

    <FundingRequestDialog open={requestOpen} onOpenChange={setRequestOpen} currency={baseCurrency} defaultPeriod={month === "all" ? currentPeriod : month} />
    <AllocationDialog open={allocationOpen} onOpenChange={closeAllocation} initial={allocationTarget} period={currentPeriod} currency={allocationTarget?.currency ?? baseCurrency} departments={departments} history={allocationTarget ? allocations.find((a) => a.departmentId === allocationTarget.departmentId && a.period === allocationTarget.period && a.currency === allocationTarget.currency)?.changes ?? [] : []} />
    <ReviewDialog request={reviewTarget} onClose={() => setReviewTarget(null)} />
  </div>;
}
