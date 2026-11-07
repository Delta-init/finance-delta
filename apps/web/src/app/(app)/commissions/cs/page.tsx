"use client";

import { Fragment, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronRight, FileText, Headset, Loader2, Search, Split, Upload, Users, Wallet, X } from "lucide-react";
import { EXPENSE_DEFAULTS, type CsCommissionKind, type CsCommissionPerson, type CsCommissionPool, type CsCommissionPoolShare, type CsCommissionStage, type UploadedExpenseFile } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useExpenseCategories } from "@/features/expense-categories/api";
import { CategoryPicker, useCategoryChoice } from "@/features/expense-categories/CategoryPicker";
import { useAllDepartments } from "@/features/departments/api";
import { PAYOUT_METHOD_LABELS, PayoutFields, emptyPayout, payoutValid, type Payout } from "@/features/hrms-payouts/payout-fields";
import { useFileDrop } from "@/components/ui/file-drop";
import { uploadCsCommissionReceipt, useApproveCsCommission, useCsCommission, useCsCommissionInvoice, usePayCsCommission, useRecordCsCommissionPayment, useRevokeCsCommission, useSplitCsCommissionPool } from "@/features/cs-commission/api";
import { InvoiceDetail } from "@/features/invoices/InvoiceDetail";
import { useOrganization } from "@/features/organization/api";

/*
 * The CS Portal's commission (the user, 2026-11-03: "CS commission in finance, beside the CRM commission, in AED").
 * A period — bonus monthly, deposit quarterly — per CS: their credits there (USD) in their own currency (AED at 3.67;
 * INR at 100 for a Bangalore team's CS), and how far the CS Portal's chain has got. Once the broker admin and the
 * academic head have approved it there, a manager approves it here — the CS Portal's Finance step, which releases the
 * credits there — its amount frozen; accounts pay it with the receipt, or a payroll run's Pull commission pays it.
 */

const NO_DEPARTMENT = "__none__";
const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd = (n: number) => `USD ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dubaiNow = () => new Date(Date.now() + 4 * 3_600_000);
/** Approvals start once a period has ended: last month, and the last quarter that has. */
const lastMonth = () => { const d = dubaiNow(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const lastQuarter = () => { const d = dubaiNow(); const q = Math.floor(d.getUTCMonth() / 3); return q === 0 ? `${d.getUTCFullYear() - 1}-Q4` : `${d.getUTCFullYear()}-Q${q}`; };
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const periodName = (kind: CsCommissionKind, p: string) => (kind === "bonus" ? monthName(p) : p.replace(/^(\d{4})-(Q\d)$/, "$2 $1"));
const METHOD: Record<string, string> = { bonus_with: "Bonus with MT5", bonus_without: "Bonus without MT5", deposit: "Deposit" };
const STAGE_LABEL: Record<string, string> = {
  pending_broker_approval: "With the broker admin", pending_academic_approval: "With the academic head",
  pending_finance_approval: "With finance", released: "Released", rejected: "Rejected",
};

type Pick = { person: CsCommissionPerson };
/** What someone is owed for the period: their own credits, and their share of the pools not split yet (2026-11-07). */
const dueMinor = (p: CsCommissionPerson) => p.amountMinor + (p.poolMinor ?? 0);
const dueUsd = (p: CsCommissionPerson) => p.totalUsd + (p.poolUsd ?? 0);

export default function CsCommissionPage() {
  const [kind, setKind] = useState<CsCommissionKind>("bonus");
  const [month, setMonth] = useState(lastMonth);
  const [quarter, setQuarter] = useState(lastQuarter);
  const period = kind === "bonus" ? month : quarter;
  const { data, isLoading, error } = useCsCommission(kind, period);
  const [approving, setApproving] = useState<Pick | null>(null);
  const [paying, setPaying] = useState<Pick | null>(null);
  // Approve and pay in one step (2026-11-06) — before the CS Portal's approvals too, with a reason.
  const [recording, setRecording] = useState<Pick | null>(null);
  // A Senior/Junior pool to split (2026-11-07).
  const [splitting, setSplitting] = useState<CsCommissionPool | null>(null);
  const years = Array.from({ length: 4 }, (_, i) => String(dubaiNow().getUTCFullYear() - i));
  const [qYear, qNum] = quarter.split("-");

  return (
    <div className="space-y-5 p-4 md:p-6">
      <Link href="/commissions" className="inline-flex items-center gap-1 text-sm text-foreground-muted hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Commissions
      </Link>
      <PageHeader
        icon={Headset}
        title="CS commission"
        description="Each CS's commission from the CS Portal — bonus commission by month, deposit commission by quarter — in AED (INR for a Bangalore team). Once the broker admin and academic head approve it there, a manager approves it here; accounts then pay it with the receipt, or payroll pays it."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-border p-0.5">
              {(["bonus", "deposit"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setKind(k)}
                  className={`rounded px-3 py-1 text-sm ${kind === k ? "bg-primary text-primary-foreground" : "text-foreground-muted hover:text-foreground"}`}>
                  {k === "bonus" ? "Bonus (monthly)" : "Deposit (quarterly)"}
                </button>
              ))}
            </div>
            {kind === "bonus" ? (
              <Input aria-label="Month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-[170px]" />
            ) : (
              <div className="flex gap-2">
                <Select value={qNum} onValueChange={(q) => setQuarter(`${qYear}-${q}`)}>
                  <SelectTrigger aria-label="Quarter" className="w-[90px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{["Q1", "Q2", "Q3", "Q4"].map((q) => <SelectItem key={q} value={q}>{q}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={qYear} onValueChange={(y) => setQuarter(`${y}-${qNum}`)}>
                  <SelectTrigger aria-label="Year" className="w-[100px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{years.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
          </div>
        }
      />

      {isLoading ? (
        <Card className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>
      ) : error || !data ? (
        <Card className="px-5 py-12 text-center text-sm text-foreground-muted">
          <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" />
          {error instanceof ApiError && error.status === 404 ? "This needs the latest finance API — ask for it to be updated." : error instanceof ApiError ? error.message : "Could not load the CS commission."}
        </Card>
      ) : (
        <>
          {!data.ended && (
            <p className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-foreground-muted">
              {periodName(kind, period)} is still running — its commission can be approved once it ends.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            {data.totals.map((t) => (
              <Card key={t.currency} className="p-4">
                <p className="text-sm font-semibold">{t.currency === "INR" ? "Bangalore (INR)" : "Dubai (AED)"}</p>
                <p className="mt-1 text-xl font-bold font-numeric">{money(t.amountMinor, t.currency)}</p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {data.people.filter((p) => p.currency === t.currency).length} CS · approved {money(t.approvedMinor, t.currency)} · paid {money(t.paidMinor, t.currency)}
                </p>
              </Card>
            ))}
          </div>
          {!!data.pools?.length && (
            <PoolsCard pools={data.pools} kind={kind} period={period} ended={data.ended} canSplit={data.canApprove && data.canPay} onSplit={setSplitting} />
          )}
          <CsTable people={data.people} kind={kind} period={period} ended={data.ended} canApprove={data.canApprove} canPay={data.canPay}
            onApprove={(person) => setApproving({ person })} onPay={(person) => setPaying({ person })} onRecord={(person) => setRecording({ person })} />
        </>
      )}

      <ApproveDialog pick={approving} kind={kind} period={period} onClose={() => setApproving(null)} />
      <PayDialog pick={paying} kind={kind} period={period} onClose={() => setPaying(null)} />
      <PayDialog pick={recording} kind={kind} period={period} onClose={() => setRecording(null)} mode="record" />
      <SplitPoolDialog pool={splitting} kind={kind} period={period} onClose={() => setSplitting(null)} />
    </div>
  );
}

/**
 * The Senior/Junior pools not split yet (the user, 2026-11-07: "why are the junior and senior mentors not visible
 * here"): a plan position flagged Pool pays its share into the Chief's pool, which the CS Portal splits equally among
 * its members once the period ends (its Distribute button) — until then the Juniors and Seniors had nothing of their
 * own, so they weren't here. Their shares are on their rows now; splitting gives each one their own commission there.
 */
function PoolsCard({ pools, kind, period, ended, canSplit, onSplit }: {
  pools: CsCommissionPool[]; kind: CsCommissionKind; period: string; ended: boolean; canSplit: boolean; onSplit: (p: CsCommissionPool) => void;
}) {
  return (
    <Card className="space-y-3 p-4">
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4" /> Senior / Junior pools not split yet</p>
        <p className="mt-0.5 text-xs text-foreground-muted">
          Juniors&rsquo; and Seniors&rsquo; share of each {kind === "bonus" ? "bonus" : "deposit"} goes into their Chief&rsquo;s pool, split equally among its members once
          the {kind === "bonus" ? "month" : "quarter"} ends. Their shares are shown on their rows below; splitting gives each one their own commission in the CS Portal,
          for the broker admin and academic head to approve as usual.
        </p>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {pools.map((g) => (
          <div key={`${g.groupId}:${g.method}`} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{g.groupName || "Pool"} <span className="font-normal text-foreground-muted">· {METHOD[g.method] ?? g.method}</span></p>
              <p className="text-xs text-foreground-muted">{g.members.map((m) => m.name).join(", ")} — {money(g.shareMinor, g.currency)} each</p>
            </div>
            <div className="text-right font-numeric">
              <p className="font-semibold">{money(g.totalMinor, g.currency)}</p>
              <p className="text-xs text-foreground-muted">{usd(g.totalUsd)}</p>
            </div>
            {!ended ? (
              <span className="text-xs text-foreground-muted">Split once {periodName(kind, period)} ends</span>
            ) : canSplit ? (
              <Button size="sm" variant="outline" onClick={() => onSplit(g)}><Split className="h-3.5 w-3.5" /> Split the pool</Button>
            ) : (
              <span className="text-xs text-foreground-muted">A manager splits it</span>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function SplitPoolDialog({ pool, kind, period, onClose }: { pool: CsCommissionPool | null; kind: CsCommissionKind; period: string; onClose: () => void }) {
  const split = useSplitCsCommissionPool();
  const submit = async () => {
    if (!pool) return;
    try {
      await split.mutateAsync({ kind, period, poolGroupId: pool.groupId, method: pool.method });
      toast.success(`${pool.groupName || "The pool"} split — each member has their share in the CS Portal now`);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not split the pool");
    }
  };
  return (
    <Dialog open={!!pool} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Split the pool</DialogTitle>
          <DialogDescription>
            {pool ? `${pool.groupName || "This pool"} — ${METHOD[pool.method] ?? pool.method}, ${periodName(kind, period)}: ${money(pool.totalMinor, pool.currency)} (${usd(pool.totalUsd)}) shared equally between ${pool.members.length} — ${money(pool.shareMinor, pool.currency)} each, as the CS Portal's Distribute splits it. Each gets it as their own commission there, for the broker admin and academic head to approve. A split can't be undone.` : ""}
          </DialogDescription>
        </DialogHeader>
        {pool && (
          <ul className="space-y-1 text-sm">
            {pool.members.map((m) => (
              <li key={m.id} className="flex justify-between gap-3"><span>{m.name}</span><span className="font-numeric">{money(pool.shareMinor, pool.currency)}</span></li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {/* Just this pool — the bonus with and without MT5 are two, split one at a time, as the CS Portal splits them. */}
          <Button loading={split.isPending} onClick={() => void submit()}><Split className="h-4 w-4" /> Split it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const tick = (s: CsCommissionStage) => (s.status === "approved" ? "✓" : s.status === "rejected" ? "✗" : "…");

function CsTable({ people, kind, period, ended, canApprove, canPay, onApprove, onPay, onRecord }: {
  people: CsCommissionPerson[]; kind: CsCommissionKind; period: string; ended: boolean; canApprove: boolean; canPay: boolean;
  onApprove: (p: CsCommissionPerson) => void; onPay: (p: CsCommissionPerson) => void; onRecord: (p: CsCommissionPerson) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  // A credit's course invoice, in a pop-up (2026-11-07).
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const revoke = useRevokeCsCommission();
  const takeBack = async (p: CsCommissionPerson) => {
    try {
      await revoke.mutateAsync({ kind, period, recipientId: p.recipientId });
      toast.success(`${p.name}'s approval taken back — it is with finance again in the CS Portal`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not take it back");
    }
  };

  if (!people.length) {
    return <Card className="px-4 py-10 text-center text-sm text-foreground-muted">No CS commission in {periodName(kind, period)}.</Card>;
  }
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-muted/60 text-left text-xs text-foreground-muted">
            <tr>
              <th className="px-4 py-2 font-medium">CS</th>
              <th className="px-4 py-2 text-right font-medium">Credits</th>
              <th className="px-4 py-2 text-right font-medium">Commission</th>
              <th className="px-4 py-2 font-medium" title="The CS Portal's approvals: broker admin, academic head, then finance (here)">CS Portal</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const isOpen = open === p.recipientId;
              return (
                <Fragment key={p.recipientId}>
                  <tr className="border-t border-border align-top">
                    <td className="px-4 py-2.5">
                      <button type="button" onClick={() => setOpen(isOpen ? null : p.recipientId)} className="flex items-start gap-1.5 text-left">
                        {isOpen ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
                        <span>
                          <span className="font-medium">{p.name || "—"}</span>
                          {!!p.pool?.length && <Badge tone="primary" className="ml-2 align-middle">Sen/Jun pool</Badge>}
                          <span className="block text-xs text-foreground-muted">{p.location === "bangalore" ? "Bangalore" : "Dubai"}{p.email ? ` · ${p.email}` : ""}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {p.credits.length}
                      {!!p.pool?.length && <span className="block text-xs text-foreground-muted">+ pool</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right font-numeric font-semibold">
                      {money(p.payout ? p.payout.amountMinor : dueMinor(p), p.currency)}
                      <span className="block text-xs font-normal text-foreground-muted">{usd(p.payout ? p.payout.amountUsd : dueUsd(p))}</span>
                      {!p.payout && (p.poolMinor ?? 0) > 0 && (
                        <span className="block text-xs font-normal text-warning" title="Their share of their Chief's Senior/Junior pool — split when the period has ended">
                          incl. {money(p.poolMinor ?? 0, p.currency)} pool share, not split yet
                        </span>
                      )}
                      {p.payout && p.payout.amountUsd !== p.totalUsd && p.credits.length > 0 && (
                        <span className="block text-xs font-normal text-warning" title="The CS Portal's figure changed after it was approved">CS Portal counts {usd(p.totalUsd)} now</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      <span className="block">{STAGE_LABEL[p.approval.overall] ?? (p.approval.overall || "—")}</span>
                      <span className="block text-foreground-muted" title="Broker admin · Academic head">Broker {tick(p.approval.broker)} · Academic {tick(p.approval.academic)}</span>
                      {p.approval.overall === "released" && !p.approval.byFinance && p.approval.releasedBy && (
                        <span className="block text-foreground-muted">released there by {p.approval.releasedBy}</span>
                      )}
                      {p.approval.override && (
                        <span className="block text-warning">released by finance before them{p.approval.overrideReason ? ` — ${p.approval.overrideReason}` : ""}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5"><StatusCell p={p} /></td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      {(p.state === "waiting" || p.state === "ready") && ended && dueMinor(p) > 0 && canApprove && (
                        <div className="flex justify-end gap-2">
                          {p.state === "ready" && (
                            <Button size="sm" variant={canPay ? "outline" : undefined} onClick={() => onApprove(p)}><Check className="h-3.5 w-3.5" /> Approve</Button>
                          )}
                          {/* Approve and pay in one step — while it waits in the CS Portal too, with a reason (2026-11-06). */}
                          {canPay && <Button size="sm" onClick={() => onRecord(p)}><Wallet className="h-3.5 w-3.5" /> Record payment</Button>}
                        </div>
                      )}
                      {p.state === "ready" && !canApprove && <span className="text-xs text-foreground-muted">Waiting for a manager</span>}
                      {p.state === "approved" && p.payout?.payrollRunNumber && (
                        <span className="text-xs text-foreground-muted">In payroll {p.payout.payrollRunNumber} — paid with it</span>
                      )}
                      {p.state === "approved" && !p.payout?.payrollRunNumber && (
                        <div className="flex justify-end gap-2">
                          {canApprove && (
                            <Button size="sm" variant="ghost" loading={revoke.isPending} onClick={() => void takeBack(p)}><X className="h-3.5 w-3.5" /> Take back</Button>
                          )}
                          {canPay && <Button size="sm" onClick={() => onPay(p)}><Wallet className="h-3.5 w-3.5" /> Mark paid</Button>}
                        </div>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t border-border bg-surface-muted/30">
                      <td colSpan={6} className="px-4 py-3">
                        {!p.credits.length && !p.pool?.length ? (
                          <p className="text-xs text-foreground-muted">No credits in the CS Portal for this period now.</p>
                        ) : (
                          <div className="space-y-4">
                            {p.credits.length > 0 && <CreditsBreakdown p={p} onInvoice={setInvoiceId} />}
                            {(p.pool ?? []).map((g) => <PoolBreakdown key={`${g.groupId}:${g.method}`} g={g} currency={p.currency} />)}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <CsInvoicePopup id={invoiceId} onClose={() => setInvoiceId(null)} />
    </Card>
  );
}

/**
 * A CS's credits for the period (the user, 2026-11-07: "show it in AED, and click the invoice to see it, like the CRM
 * commission breakdown"): in the CS's currency at the CS Portal's rate, the USD beside it; the course invoice behind a
 * credit opens in a pop-up; a search over student, invoice and transaction, on what the page has.
 */
function CreditsBreakdown({ p, onInvoice }: { p: CsCommissionPerson; onInvoice: (id: string) => void }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = p.credits.filter((c) => !needle || [c.student, c.txnId, c.invoice?.number, c.initiator, METHOD[c.method] ?? c.method]
    .some((v) => (v ?? "").toLowerCase().includes(needle)));
  const total = shown.reduce((t, c) => t + (c.amountMinor ?? 0), 0);
  const cur = p.currency;
  // From a finance API older than the AED figures: the USD at the CS Portal's rate, as the totals are.
  const inCur = (minor: number | undefined, usdValue: number) => money(minor ?? Math.round(usdValue * (cur === "INR" ? 100 : 3.67) * 100), cur);
  return (
    <div className="space-y-2">
      <div className="relative w-64 max-w-full">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search student, invoice, transaction…" className="h-8 pl-7 text-xs" />
      </div>
      <table className="w-full text-xs">
        <thead className="text-left text-foreground-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Date</th><th className="py-1 pr-3 font-medium">Student</th><th className="py-1 pr-3 font-medium">Invoice</th>
            <th className="py-1 pr-3 font-medium">For</th><th className="py-1 pr-3 font-medium">Level</th><th className="py-1 pr-3 text-right font-medium">On</th>
            <th className="py-1 pr-3 text-right font-medium">%</th><th className="py-1 text-right font-medium">Commission</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.id} className="border-t border-border/60 align-top">
              <td className="py-1 pr-3">{c.date.slice(0, 10)}</td>
              <td className="py-1 pr-3">{c.student || "—"}{c.txnId ? <span className="text-foreground-muted"> · {c.txnId}</span> : null}</td>
              <td className="py-1 pr-3">
                {c.invoice
                  ? <button type="button" onClick={() => onInvoice(c.invoice!.id)} className="text-primary hover:underline">{c.invoice.number || "Invoice"}</button>
                  : <span className="text-foreground-muted">—</span>}
              </td>
              <td className="py-1 pr-3">{METHOD[c.method] ?? c.method}{c.initiator ? <span className="text-foreground-muted"> · by {c.initiator}</span> : null}</td>
              {/* Their share of a split Senior/Junior pool (2026-11-07): no bonus or deposit of its own behind it. */}
              <td className="py-1 pr-3">{c.fromPool ? <Badge tone="primary">Pool share</Badge> : <>{c.level}{c.position ? ` · ${c.position}` : ""}</>}</td>
              <td className="py-1 pr-3 text-right font-numeric">
                {c.fromPool ? <span className="text-foreground-muted">—</span> : <>{inCur(c.baseMinor, c.baseUsd)}<span className="block text-[11px] text-foreground-muted">{usd(c.baseUsd)}</span></>}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums">{c.fromPool ? "—" : `${c.percentage}%`}</td>
              <td className="py-1 text-right font-numeric font-medium">
                {inCur(c.amountMinor, c.amountUsd)}<span className="block text-[11px] font-normal text-foreground-muted">{usd(c.amountUsd)}</span>
              </td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={8} className="py-3 text-center text-foreground-muted">Nothing matches.</td></tr>}
        </tbody>
        {needle && shown.length > 0 && (
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td colSpan={7} className="py-1 pr-3">{shown.length} of {p.credits.length} credits</td>
              <td className="py-1 text-right font-numeric">{money(total, cur)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Someone's share of a pool not split yet, and the accruals in it (2026-11-07). */
function PoolBreakdown({ g, currency }: { g: CsCommissionPoolShare; currency: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs">
        <span className="font-medium">{g.groupName || "Pool"}</span> · {METHOD[g.method] ?? g.method} — {money(g.totalMinor, currency)} between {g.members.length} ({g.members.join(", ")}):
        {" "}<span className="font-medium">their share {money(g.shareMinor, currency)}</span> <span className="text-warning">· not split yet</span>
      </p>
      <table className="w-full text-xs">
        <thead className="text-left text-foreground-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Date</th><th className="py-1 pr-3 font-medium">Student</th><th className="py-1 pr-3 font-medium">Held by</th>
            <th className="py-1 pr-3 font-medium">Level</th><th className="py-1 pr-3 text-right font-medium">%</th><th className="py-1 text-right font-medium">Into the pool</th>
          </tr>
        </thead>
        <tbody>
          {g.credits.map((c) => (
            <tr key={c.id} className="border-t border-border/60">
              <td className="py-1 pr-3">{c.date.slice(0, 10)}</td>
              <td className="py-1 pr-3">{c.student || "—"}</td>
              <td className="py-1 pr-3">{c.heldBy || "—"}</td>
              <td className="py-1 pr-3">{c.level}{c.position ? ` · ${c.position}` : ""}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{c.percentage}%</td>
              <td className="py-1 text-right font-numeric">{money(c.amountMinor, currency)}<span className="block text-[11px] text-foreground-muted">{usd(c.amountUsd)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A credit's course invoice, whole and read-only, as the invoice page shows it (2026-11-07). */
function CsInvoicePopup({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading, error } = useCsCommissionInvoice(id);
  const { data: org } = useOrganization();
  return (
    <Dialog open={!!id} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto p-0">
        <DialogHeader className="sr-only"><DialogTitle>Invoice</DialogTitle></DialogHeader>
        {isLoading ? <p className="p-6 text-sm text-foreground-muted">Loading…</p>
          : error || !data ? <p className="p-6 text-sm text-danger">{error instanceof ApiError ? error.message : "The invoice could not be loaded."}</p>
          : <InvoiceDetail id={id!} preloaded={{ invoice: data.invoice, orgName: data.orgName, sameOrg: !!org && data.orgId === org.id }} />}
      </DialogContent>
    </Dialog>
  );
}

function StatusCell({ p }: { p: CsCommissionPerson }) {
  if (p.state === "waiting") return <Badge tone="neutral">In the CS Portal</Badge>;
  if (p.state === "rejected") return <Badge tone="danger">Rejected there</Badge>;
  if (p.state === "ready") return <Badge tone="primary">Ready to approve</Badge>;
  const o = p.payout!;
  if (o.state === "approved") {
    return (
      <div className="space-y-0.5">
        <Badge tone="warning">{o.payrollRunNumber ? `In payroll ${o.payrollRunNumber}` : "Approved — to pay"}</Badge>
        <p className="text-xs text-foreground-muted">by {o.approvedByName}, {o.approvedAt.slice(0, 10)}{o.approvalNote ? ` — ${o.approvalNote}` : ""}</p>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <Badge tone="success">Paid</Badge>
      <p className="text-xs text-foreground-muted">
        {o.paidOn} by {o.paymentMethod === "payroll" ? "payroll" : PAYOUT_METHOD_LABELS[o.paymentMethod as keyof typeof PAYOUT_METHOD_LABELS] ?? o.paymentMethod}
        {o.reference ? ` · ${o.reference}` : ""} · {o.paidByName}{o.orgName ? ` · ${o.orgName}` : ""}
      </p>
      <p className="flex flex-wrap gap-x-3 text-xs">
        {o.expense && (o.expense.status === "gone"
          ? <span className="text-danger">{o.expense.expenseNumber} (deleted)</span>
          : <Link href={`/expenses/${o.expense.id}`} className="text-primary hover:underline">{o.expense.expenseNumber}{o.expense.status === "voided" ? " (voided)" : ""}</Link>)}
        {o.receipt && <a href={o.receipt.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><FileText className="h-3 w-3" /> Receipt</a>}
      </p>
      <p className="text-xs text-foreground-muted">Approved by {o.approvedByName}</p>
      {o.beforePortal && (
        <p className="text-xs text-warning">Paid before the CS Portal&rsquo;s approvals{o.approvalNote ? ` — ${o.approvalNote}` : ""}</p>
      )}
    </div>
  );
}

function ApproveDialog({ pick, kind, period, onClose }: { pick: Pick | null; kind: CsCommissionKind; period: string; onClose: () => void }) {
  const approve = useApproveCsCommission();
  const [note, setNote] = useState("");
  const submit = async () => {
    if (!pick) return;
    try {
      await approve.mutateAsync({ kind, period, recipientId: pick.person.recipientId, note: note.trim() });
      toast.success(`${pick.person.name}'s ${periodName(kind, period)} commission approved — released in the CS Portal; accounts can pay it now`);
      setNote("");
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not approve it");
    }
  };
  const p = pick?.person;
  return (
    <Dialog open={!!pick} onOpenChange={(o) => { if (!o) { setNote(""); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Approve CS commission</DialogTitle>
          <DialogDescription>
            {p ? `${p.name} · ${kind === "bonus" ? "Bonus" : "Deposit"} · ${periodName(kind, period)} — ${money(dueMinor(p), p.currency)} (${usd(dueUsd(p))}, ${p.credits.length} credit${p.credits.length === 1 ? "" : "s"}${(p.poolMinor ?? 0) > 0 ? ` and ${money(p.poolMinor ?? 0, p.currency)} from their pool, which is split first` : ""}). This is the CS Portal's Finance step: their credits are released there, and the amount is frozen here for accounts to pay.` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="cs-approve-note">Note (optional)</Label>
          <Input id="cs-approve-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="For accounts" />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={approve.isPending} onClick={() => void submit()}><Check className="h-4 w-4" /> Approve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PayDialog({ pick, kind, period, onClose, mode = "pay" }: { pick: Pick | null; kind: CsCommissionKind; period: string; onClose: () => void; mode?: "pay" | "record" }) {
  const categories = useExpenseCategories();
  const departments = useAllDepartments();
  const payApproved = usePayCsCommission();
  const record = useRecordCsCommissionPayment();
  const pay = mode === "record" ? record : payApproved;
  const [reason, setReason] = useState("");
  // Still with the broker admin or academic head in the CS Portal: paying it now goes before them, so say why.
  const early = mode === "record" && pick?.person.state === "waiting";
  const waitingFor = pick?.person.approval.overall === "pending_academic_approval" ? "the academic head" : "the broker admin";
  const [payout, setPayout] = useState<Payout>(emptyPayout);
  const [department, setDepartment] = useState(NO_DEPARTMENT);
  const [receipt, setReceipt] = useState<UploadedExpenseFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const categoryList = categories.data ?? [];
  // Sales / Mentor Commission › Mentor Commission — a CS.
  const cat = useCategoryChoice(categoryList, EXPENSE_DEFAULTS.csCommission);
  const reset = () => { setPayout(emptyPayout()); cat.reset(); setDepartment(NO_DEPARTMENT); setReceipt(null); setReason(""); };
  const close = () => { reset(); onClose(); };

  const pickFile = async (file: File) => {
    if (!["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"].includes(file.type)) { toast.error("The receipt must be a JPG, PNG, WebP, GIF or PDF"); return; }
    if (file.size > 10 * 1024 * 1024) { toast.error("The receipt must be 10 MB or smaller"); return; }
    setUploading(true);
    try {
      setReceipt(await uploadCsCommissionReceipt(file));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not upload the receipt");
    } finally {
      setUploading(false);
    }
  };
  const receiptDrop = useFileDrop({
    onFiles: ([f]) => { if (f) void pickFile(f); },
    accept: "image/jpeg,image/png,image/webp,image/gif,application/pdf",
    disabled: !pick || uploading || !!receipt,
  });

  const submit = async () => {
    if (!pick || !receipt) return;
    try {
      const input = {
        kind, period, recipientId: pick.person.recipientId, ...payout, category: cat.value.category, subcategory: cat.value.subcategory || undefined,
        departmentId: department === NO_DEPARTMENT ? "" : department,
        receipt: { name: receipt.name, key: receipt.key, size: receipt.size, mimeType: receipt.mimeType },
      };
      const res = mode === "record" ? await record.mutateAsync({ ...input, reason: reason.trim() }) : await payApproved.mutateAsync(input);
      toast.success(`Paid — ${res.expense.expenseNumber} recorded with the receipt`);
      close();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not record the payment");
    }
  };

  const o = pick?.person.payout;
  return (
    <Dialog open={!!pick} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "record" ? "Record CS commission payment" : "Mark CS commission paid"}</DialogTitle>
          <DialogDescription>
            {mode === "record" && pick
              ? `${pick.person.name} · ${periodName(kind, period)} — ${money(dueMinor(pick.person), pick.person.currency)}${(pick.person.poolMinor ?? 0) > 0 ? `, of which ${money(pick.person.poolMinor ?? 0, pick.person.currency)} is their pool share (the pool is split first, for every member)` : ""}. Approved and paid in one step: a paid expense with the receipt, and their credits released in the CS Portal so it can't be paid twice${pick.person.currency === "INR" ? " — pay it from the Bangalore organization (INR)" : ""}.`
              : pick && o ? `${pick.person.name} · ${periodName(kind, period)} — ${money(o.amountMinor, o.currency)}, as approved by ${o.approvedByName}. Recorded as a paid expense with the receipt${o.currency === "INR" ? " — pay it from the Bangalore organization (INR)" : ""}.` : ""}
          </DialogDescription>
        </DialogHeader>
        {early && (
          <div className="space-y-1.5 rounded-lg border border-warning/30 bg-warning/5 p-3">
            <p className="flex items-start gap-1.5 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>Still with {waitingFor} in the CS Portal. Recording it now pays it before {waitingFor === "the broker admin" ? "the broker admin and academic head" : "the academic head"} approve — the CS Portal keeps your reason on the release.</span>
            </p>
            <Label htmlFor="cs-commission-reason">Why it is paid now *</Label>
            <Input id="cs-commission-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Leaving this month, paid with the final settlement" />
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <PayoutFields value={payout} onChange={setPayout} idPrefix="cs-commission" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <CategoryPicker categories={categoryList} value={cat.value} onChange={cat.set} idPrefix="cs-commission" loading={categories.isLoading} />
          <div className="space-y-1.5">
            <Label htmlFor="cs-commission-department">Department (optional)</Label>
            <Select value={department} onValueChange={setDepartment} disabled={departments.isLoading}>
              <SelectTrigger id="cs-commission-department"><SelectValue placeholder="No department" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DEPARTMENT}>No department</SelectItem>
                {(departments.data ?? []).map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="relative space-y-1.5" {...receiptDrop.zoneProps}>
          {receiptDrop.overlay}
          <Label>Receipt *</Label>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pickFile(f); }} />
          {receipt ? (
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <FileText className="h-4 w-4 shrink-0 text-foreground-muted" />
              <a href={receipt.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate hover:underline">{receipt.name}</a>
              <Button size="sm" variant="ghost" onClick={() => setReceipt(null)} aria-label="Remove"><X className="h-4 w-4" /></Button>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> Upload the receipt
            </Button>
          )}
          <p className="text-xs text-foreground-muted">JPG, PNG, WebP, GIF or PDF, up to 10 MB.</p>
          {receiptDrop.hint}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button loading={pay.isPending} disabled={!receipt || uploading || !cat.complete || !payoutValid(payout) || (early && reason.trim().length < 5)} onClick={() => void submit()}>
            <Wallet className="h-4 w-4" /> {mode === "record" ? "Record payment" : "Mark paid"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
