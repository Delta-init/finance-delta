"use client";

import { Fragment, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronRight, FileText, Headset, Loader2, Upload, Wallet, X } from "lucide-react";
import { EXPENSE_DEFAULTS, type CsCommissionKind, type CsCommissionPerson, type CsCommissionStage, type UploadedExpenseFile } from "@delta/shared";
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
import { uploadCsCommissionReceipt, useApproveCsCommission, useCsCommission, usePayCsCommission, useRecordCsCommissionPayment, useRevokeCsCommission } from "@/features/cs-commission/api";

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
          <CsTable people={data.people} kind={kind} period={period} ended={data.ended} canApprove={data.canApprove} canPay={data.canPay}
            onApprove={(person) => setApproving({ person })} onPay={(person) => setPaying({ person })} onRecord={(person) => setRecording({ person })} />
        </>
      )}

      <ApproveDialog pick={approving} kind={kind} period={period} onClose={() => setApproving(null)} />
      <PayDialog pick={paying} kind={kind} period={period} onClose={() => setPaying(null)} />
      <PayDialog pick={recording} kind={kind} period={period} onClose={() => setRecording(null)} mode="record" />
    </div>
  );
}

const tick = (s: CsCommissionStage) => (s.status === "approved" ? "✓" : s.status === "rejected" ? "✗" : "…");

function CsTable({ people, kind, period, ended, canApprove, canPay, onApprove, onPay, onRecord }: {
  people: CsCommissionPerson[]; kind: CsCommissionKind; period: string; ended: boolean; canApprove: boolean; canPay: boolean;
  onApprove: (p: CsCommissionPerson) => void; onPay: (p: CsCommissionPerson) => void; onRecord: (p: CsCommissionPerson) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
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
                          <span className="block text-xs text-foreground-muted">{p.location === "bangalore" ? "Bangalore" : "Dubai"}{p.email ? ` · ${p.email}` : ""}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{p.credits.length}</td>
                    <td className="px-4 py-2.5 text-right font-numeric font-semibold">
                      {money(p.payout ? p.payout.amountMinor : p.amountMinor, p.currency)}
                      <span className="block text-xs font-normal text-foreground-muted">{usd(p.payout ? p.payout.amountUsd : p.totalUsd)}</span>
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
                      {(p.state === "waiting" || p.state === "ready") && ended && p.amountMinor > 0 && canApprove && (
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
                        {!p.credits.length ? (
                          <p className="text-xs text-foreground-muted">No credits in the CS Portal for this period now.</p>
                        ) : (
                          <table className="w-full text-xs">
                            <thead className="text-left text-foreground-muted">
                              <tr>
                                <th className="py-1 pr-3 font-medium">Date</th><th className="py-1 pr-3 font-medium">Student</th><th className="py-1 pr-3 font-medium">For</th>
                                <th className="py-1 pr-3 font-medium">Level</th><th className="py-1 pr-3 text-right font-medium">On</th>
                                <th className="py-1 pr-3 text-right font-medium">%</th><th className="py-1 text-right font-medium">Commission</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.credits.map((c) => (
                                <tr key={c.id} className="border-t border-border/60">
                                  <td className="py-1 pr-3">{c.date.slice(0, 10)}</td>
                                  <td className="py-1 pr-3">{c.student || "—"}{c.txnId ? <span className="text-foreground-muted"> · {c.txnId}</span> : null}</td>
                                  <td className="py-1 pr-3">{METHOD[c.method] ?? c.method}{c.initiator ? <span className="text-foreground-muted"> · by {c.initiator}</span> : null}</td>
                                  <td className="py-1 pr-3">{c.level}{c.position ? ` · ${c.position}` : ""}</td>
                                  <td className="py-1 pr-3 text-right font-numeric">{usd(c.baseUsd)}</td>
                                  <td className="py-1 pr-3 text-right tabular-nums">{c.percentage}%</td>
                                  <td className="py-1 text-right font-numeric">{usd(c.amountUsd)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
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
    </Card>
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
            {p ? `${p.name} · ${kind === "bonus" ? "Bonus" : "Deposit"} · ${periodName(kind, period)} — ${money(p.amountMinor, p.currency)} (${usd(p.totalUsd)}, ${p.credits.length} credit${p.credits.length === 1 ? "" : "s"}). This is the CS Portal's Finance step: their credits are released there, and the amount is frozen here for accounts to pay.` : ""}
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
              ? `${pick.person.name} · ${periodName(kind, period)} — ${money(pick.person.amountMinor, pick.person.currency)}. Approved and paid in one step: a paid expense with the receipt, and their credits released in the CS Portal so it can't be paid twice${pick.person.currency === "INR" ? " — pay it from the Bangalore organization (INR)" : ""}.`
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
