"use client";

import { Fragment, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronRight, FileText, Loader2, Upload, Users, Wallet, X } from "lucide-react";
import { EXPENSE_DEFAULTS, type CrmCommissionCrm, type CrmCommissionPerson, type UploadedExpenseFile } from "@delta/shared";
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
import {
  uploadCommissionReceipt, useApproveCrmCommission, useCrmCommission, usePayCrmCommission, useRevokeCrmCommission,
} from "@/features/crm-commission/api";

/*
 * The sales CRMs' commission (the user, 2026-10-21: "commission of each CRM needs to show here, a manager approves,
 * then accounts mark it paid with the receipt"). A month, per CRM: what each person is paid of their commission — the
 * CRM's My Pay "commission payable", the commission earned (salesperson, team leader, sales manager lines added up)
 * × their salary-slab level's percent (2026-10-21) — with the earned figure and the sales behind it. A manager
 * approves a person's month — its amount frozen — and accounts pay it with the receipt: a paid expense in its bank or
 * cash book. The CRM's My Pay shows where it stands.
 */

const NO_DEPARTMENT = "__none__";
const ROLE = { sales: "Salesperson", tl: "Team leader", sm: "Sales manager" } as Record<string, string>;
const thisMonth = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 7);
const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
/** Collected in a currency there was no rate for (2026-10-31) — said apart, never added in: " + INR 57,375". */
const plusOther = (list: { currency: string; amountMinor: number }[] | undefined) => (list ?? []).map((o) => ` + ${money(o.amountMinor, o.currency)}`).join("");
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

type Pick = { crm: CrmCommissionCrm; person: CrmCommissionPerson };

export default function CrmCommissionPage() {
  const [month, setMonth] = useState(thisMonth);
  const { data, isLoading, error } = useCrmCommission(month);
  const [approving, setApproving] = useState<Pick | null>(null);
  const [paying, setPaying] = useState<Pick | null>(null);

  return (
    <div className="space-y-5 p-4 md:p-6">
      <Link href="/commissions" className="inline-flex items-center gap-1 text-sm text-foreground-muted hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Commissions
      </Link>
      <PageHeader
        icon={Users}
        title="CRM commission"
        description="Each sales CRM's commission payable for the month, as the CRM's My Pay works it out (commission earned × the slab level's %). A manager approves a person's month, then accounts mark it paid with the receipt."
        action={
          <div className="flex items-center gap-2">
            <Label htmlFor="crm-commission-month" className="text-sm text-foreground-muted">Month</Label>
            <Input id="crm-commission-month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-[170px]" />
          </div>
        }
      />

      {isLoading ? (
        <Card className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></Card>
      ) : error || !data ? (
        <Card className="px-5 py-12 text-center text-sm text-foreground-muted">
          <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-danger" />
          {error instanceof ApiError && error.status === 404 ? "This needs the latest finance API — ask for it to be updated." : error instanceof ApiError ? error.message : "Could not load the CRMs' commission."}
        </Card>
      ) : (
        <>
          {month === thisMonth() && (
            <p className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-foreground-muted">
              {monthLabel(month)} is still running — sales finance approves add to it. An approval freezes the amount; anything counted later shows as changed.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            {data.crms.filter((c) => !c.error || c.people.length).map((c) => {
              const approved = c.people.filter((p) => p.state === "approved").reduce((t, p) => t + (p.payout?.amountMinor ?? 0), 0);
              const paid = c.people.filter((p) => p.state === "paid").reduce((t, p) => t + (p.payout?.amountMinor ?? 0), 0);
              return (
                <Card key={c.code} className="p-4">
                  <p className="text-sm font-semibold">{c.name}</p>
                  <p className="mt-1 text-xl font-bold font-numeric">{c.payError ? "—" : money(c.totalMinor, c.currency)}</p>
                  <p className="mt-1 text-xs text-foreground-muted">
                    payable of {money(c.earnedTotalMinor, c.currency)} earned · {c.people.length} {c.people.length === 1 ? "person" : "people"}
                  </p>
                  <p className="text-xs text-foreground-muted">collected <span className="font-medium text-foreground">{money(c.collectedTotalMinor ?? 0, c.currency)}{plusOther(c.collectedOther)}</span> on the month's sales</p>
                  <p className="text-xs text-foreground-muted">approved {money(approved, c.currency)} · paid {money(paid, c.currency)}</p>
                </Card>
              );
            })}
          </div>
          {data.crms.map((c) => (
            <CrmTable key={c.code} crm={c} month={month} canApprove={data.me.canApprove} canPay={data.me.canPay}
              onApprove={(person) => setApproving({ crm: c, person })} onPay={(person) => setPaying({ crm: c, person })} />
          ))}
        </>
      )}

      <ApproveDialog pick={approving} month={month} onClose={() => setApproving(null)} />
      <PayDialog pick={paying} month={month} onClose={() => setPaying(null)} />
    </div>
  );
}

function CrmTable({ crm, month, canApprove, canPay, onApprove, onPay }: {
  crm: CrmCommissionCrm; month: string; canApprove: boolean; canPay: boolean;
  onApprove: (p: CrmCommissionPerson) => void; onPay: (p: CrmCommissionPerson) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const revoke = useRevokeCrmCommission();
  const takeBack = async (p: CrmCommissionPerson) => {
    try {
      await revoke.mutateAsync({ crm: crm.code, month, userId: p.userId });
      toast.success(`${p.name}'s approval taken back`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not take it back");
    }
  };

  return (
    <Card className="overflow-hidden" data-testid={`crm-commission-${crm.code}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="font-semibold">{crm.name}</h2>
        <p className="text-xs text-foreground-muted">
          {crm.payError ? "" : `${money(crm.totalMinor, crm.currency)} payable · `}{money(crm.earnedTotalMinor, crm.currency)} earned · {money(crm.collectedTotalMinor ?? 0, crm.currency)}{plusOther(crm.collectedOther)} collected
          {/* Counted at finance's approval since 2026-10-26: "progress" is waiting for it; "waiting" is on hold in the CRM (its team). */}
          {crm.pending.progress > 0 && ` · ${crm.pending.progress} sale${crm.pending.progress === 1 ? "" : "s"} waiting for finance's approval`}
          {crm.pending.waiting > 0 && ` · ${crm.pending.waiting} on hold in the CRM`}
        </p>
      </div>
      {!crm.error && crm.payError && (
        <p className="flex items-center gap-2 border-b border-border bg-warning/5 px-4 py-2 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> My Pay's figures aren't available: {crm.payError} Nothing can be approved until they are.
        </p>
      )}
      {crm.error ? (
        <p className="flex items-center gap-2 px-4 py-6 text-sm text-warning"><AlertTriangle className="h-4 w-4" /> {crm.error}</p>
      ) : !crm.people.length ? (
        <p className="px-4 py-6 text-center text-sm text-foreground-muted">No commission counted in {monthLabel(month)}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted/60 text-left text-xs text-foreground-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Person</th>
                <th className="px-4 py-2 text-right font-medium">Sales</th>
                <th className="px-4 py-2 text-right font-medium" title="What their sales' invoices have collected — each sale once">Collected</th>
                <th className="px-4 py-2 text-right font-medium" title="My Pay's commission payable: earned × the slab level's %">Payable</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {crm.people.map((p) => {
                const isOpen = open === p.userId;
                return (
                  <Fragment key={p.userId}>
                    <tr className="border-t border-border align-top">
                      <td className="px-4 py-2.5">
                        <button type="button" onClick={() => setOpen(isOpen ? null : p.userId)} className="flex items-start gap-1.5 text-left">
                          {isOpen ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
                          <span>
                            <span className="font-medium">{p.name}</span>
                            <span className="block text-xs text-foreground-muted">{p.roles.map((r) => ROLE[r] ?? r).join(" · ") || "—"}</span>
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{p.sales}</td>
                      <td className="px-4 py-2.5 text-right font-numeric">
                        {money(p.collectedMinor ?? 0, crm.currency)}
                        {!!p.collectedOther?.length && <span className="block text-xs text-foreground-muted">{plusOther(p.collectedOther).slice(1)}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-numeric font-semibold">
                        {p.payout ? money(p.payout.amountMinor, crm.currency) : p.payableKnown ? money(p.amountMinor, crm.currency) : "—"}
                        <span className="block text-xs font-normal text-foreground-muted">
                          {p.percent !== null ? `${p.percent}% of ` : ""}{money(p.earnedMinor, crm.currency)} earned{p.level ? ` · ${p.level}` : ""}
                        </span>
                        {p.changed && (
                          <span className="block text-xs font-normal text-warning" title="The CRM's figure changed after it was approved">
                            CRM counts {money(p.amountMinor, crm.currency)} now
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusCell p={p} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        {p.state === "earned" && canApprove && p.payableKnown && p.amountMinor > 0 && (
                          <Button size="sm" onClick={() => onApprove(p)}><Check className="h-3.5 w-3.5" /> Approve</Button>
                        )}
                        {p.state === "approved" && (
                          <div className="flex justify-end gap-2">
                            {canApprove && (
                              <Button size="sm" variant="ghost" loading={revoke.isPending} onClick={() => void takeBack(p)}><X className="h-3.5 w-3.5" /> Take back</Button>
                            )}
                            {canPay && <Button size="sm" onClick={() => onPay(p)}><Wallet className="h-3.5 w-3.5" /> Mark paid</Button>}
                          </div>
                        )}
                        {p.state === "earned" && p.payableKnown && p.amountMinor === 0 && <span className="text-xs text-foreground-muted">Nothing payable at this level</span>}
                        {p.state === "earned" && !canApprove && p.amountMinor > 0 && <span className="text-xs text-foreground-muted">Waiting for a manager</span>}
                        {p.state === "approved" && !canPay && !canApprove && <span className="text-xs text-foreground-muted">Waiting for accounts</span>}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-border bg-surface-muted/30">
                        <td colSpan={6} className="px-4 py-2">
                          {!p.lines.length ? (
                            <p className="py-2 text-xs text-foreground-muted">No sales counted for {p.name} now.</p>
                          ) : (
                            <table className="w-full text-xs">
                              <thead className="text-left text-foreground-muted">
                                <tr><th className="py-1 font-medium">Sale</th><th className="py-1 font-medium">Student</th><th className="py-1 font-medium">Course</th><th className="py-1 font-medium">Invoice</th><th className="py-1 pr-6 text-right font-medium" title="Collected of the invoice's total">Collected</th><th className="py-1 font-medium">As</th><th className="py-1 text-right font-medium">Commission</th></tr>
                              </thead>
                              <tbody>
                                {p.lines.map((l, i) => (
                                  <tr key={`${l.saleId}:${l.role}:${i}`} className="border-t border-border/60">
                                    <td className="py-1">{l.saleDate.slice(0, 10)}</td>
                                    <td className="py-1">{l.student || "—"}</td>
                                    <td className="py-1">{l.course || "—"}</td>
                                    <td className="py-1">{l.invoiceNumber || "—"}</td>
                                    <td className="py-1 pr-6 text-right font-numeric">
                                      {l.collectedMinor != null ? `${l.invoiceCurrency ? "≈ " : ""}${money(l.collectedMinor, crm.currency)}`
                                        : l.invoiceCurrency ? money(l.invoiceCollectedMinor ?? 0, l.invoiceCurrency) : <span className="text-foreground-muted">—</span>}
                                      {l.feeMinor != null && l.collectedMinor != null && l.collectedMinor < l.feeMinor && <span className="block text-[10px] text-foreground-muted">of {money(l.feeMinor, crm.currency)}</span>}
                                      {/* A Bangalore sale's rupees (2026-10-31): the invoice's own figure under the AED it counts as */}
                                      {l.invoiceCurrency && l.collectedMinor != null && (
                                        <span className="block text-[10px] text-foreground-muted">
                                          {money(l.invoiceCollectedMinor ?? 0, l.invoiceCurrency)}{(l.invoiceFeeMinor ?? 0) > (l.invoiceCollectedMinor ?? 0) ? ` of ${money(l.invoiceFeeMinor ?? 0, l.invoiceCurrency)}` : ""}
                                        </span>
                                      )}
                                      {l.invoiceCurrency && l.collectedMinor == null && <span className="block text-[10px] text-foreground-muted">no rate to {crm.currency}</span>}
                                    </td>
                                    <td className="py-1">{ROLE[l.role] ?? l.role}</td>
                                    <td className="py-1 text-right font-numeric">{money(Math.round(l.amount * 100), crm.currency)}</td>
                                  </tr>
                                ))}
                              </tbody>
                              {/* Their total (the user, 2026-10-26: "show the total collected also"): each sale once — a sale
                                  counted under two roles is one invoice — with its fees when not all of it is in; and the
                                  commission earned, every line. */}
                              {(() => {
                                const sales = new Map(p.lines.map((l) => [l.saleId, l]));
                                const known = [...sales.values()].filter((l) => l.collectedMinor != null);
                                const missing = [...sales.values()].filter((l) => l.collectedMinor == null && !l.invoiceCurrency).length;
                                const collected = known.reduce((t, l) => t + (l.collectedMinor ?? 0), 0);
                                const fees = known.reduce((t, l) => t + (l.feeMinor ?? 0), 0);
                                const earned = p.lines.reduce((t, l) => t + Math.round(l.amount * 100), 0);
                                return (
                                  <tfoot>
                                    <tr className="border-t-2 border-border font-semibold">
                                      <td className="py-1.5" colSpan={4}>Total · {sales.size} sale{sales.size === 1 ? "" : "s"}{missing ? ` (${missing} with no invoice here)` : ""}</td>
                                      <td className="py-1.5 pr-6 text-right font-numeric">
                                        {money(collected, crm.currency)}{plusOther(p.collectedOther)}
                                        {fees > collected && <span className="block text-[10px] font-normal text-foreground-muted">of {money(fees, crm.currency)}</span>}
                                      </td>
                                      <td />
                                      <td className="py-1.5 text-right font-numeric">{money(earned, crm.currency)}</td>
                                    </tr>
                                  </tfoot>
                                );
                              })()}
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
      )}
    </Card>
  );
}

function StatusCell({ p }: { p: CrmCommissionPerson }) {
  if (!p.payout) return <Badge tone="neutral">Earned</Badge>;
  const o = p.payout;
  if (o.state === "approved") {
    return (
      <div className="space-y-0.5">
        <Badge tone="warning">Approved — to pay</Badge>
        <p className="text-xs text-foreground-muted">by {o.approvedByName}, {o.approvedAt.slice(0, 10)}{o.approvalNote ? ` — ${o.approvalNote}` : ""}</p>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <Badge tone="success">Paid</Badge>
      <p className="text-xs text-foreground-muted">
        {o.paidOn} by {PAYOUT_METHOD_LABELS[o.paymentMethod as keyof typeof PAYOUT_METHOD_LABELS] ?? o.paymentMethod}{o.reference ? ` · ${o.reference}` : ""} · {o.paidByName}
        {o.orgName ? ` · ${o.orgName}` : ""}
      </p>
      <p className="flex flex-wrap gap-x-3 text-xs">
        {o.expense && (o.expense.status === "gone"
          ? <span className="text-danger">{o.expense.expenseNumber} (deleted)</span>
          : <Link href={`/expenses/${o.expense.id}`} className="text-primary hover:underline">{o.expense.expenseNumber}{o.expense.status === "voided" ? " (voided)" : ""}</Link>)}
        {o.receipt && <a href={o.receipt.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><FileText className="h-3 w-3" /> Receipt</a>}
      </p>
      <p className="text-xs text-foreground-muted">Approved by {o.approvedByName}</p>
    </div>
  );
}

function ApproveDialog({ pick, month, onClose }: { pick: Pick | null; month: string; onClose: () => void }) {
  const approve = useApproveCrmCommission();
  const [note, setNote] = useState("");
  const submit = async () => {
    if (!pick) return;
    try {
      await approve.mutateAsync({ crm: pick.crm.code, month, userId: pick.person.userId, note: note.trim() });
      toast.success(`${pick.person.name}'s ${monthLabel(month)} commission approved — accounts can pay it now`);
      setNote("");
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not approve it");
    }
  };
  return (
    <Dialog open={!!pick} onOpenChange={(o) => { if (!o) { setNote(""); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Approve commission</DialogTitle>
          <DialogDescription>
            {pick ? `${pick.person.name} · ${pick.crm.name} · ${monthLabel(month)} — ${money(pick.person.amountMinor, pick.crm.currency)} payable (${pick.person.percent ?? 0}% of ${money(pick.person.earnedMinor, pick.crm.currency)} earned on ${pick.person.sales} sale${pick.person.sales === 1 ? "" : "s"}${pick.person.level ? `, ${pick.person.level}` : ""}). The amount is frozen as approved; accounts then pay it, and the CRM's My Pay shows it.` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="approve-note">Note (optional)</Label>
          <Input id="approve-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="For accounts" />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={approve.isPending} onClick={() => void submit()}><Check className="h-4 w-4" /> Approve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PayDialog({ pick, month, onClose }: { pick: Pick | null; month: string; onClose: () => void }) {
  const categories = useExpenseCategories();
  const departments = useAllDepartments();
  const pay = usePayCrmCommission();
  const [payout, setPayout] = useState<Payout>(emptyPayout);
  const [department, setDepartment] = useState(NO_DEPARTMENT);
  const [receipt, setReceipt] = useState<UploadedExpenseFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const categoryList = categories.data ?? [];
  // Sales Commission › Sales Commission, or › Team Leader Commission for someone paid only as a team leader.
  const tlOnly = !!pick && pick.person.roles.length > 0 && pick.person.roles.every((r) => r === "tl");
  const cat = useCategoryChoice(categoryList, tlOnly ? EXPENSE_DEFAULTS.crmCommissionTeamLeader : EXPENSE_DEFAULTS.crmCommission);
  const reset = () => { setPayout(emptyPayout()); cat.reset(); setDepartment(NO_DEPARTMENT); setReceipt(null); };
  const close = () => { reset(); onClose(); };

  const pickFile = async (file: File) => {
    if (!["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"].includes(file.type)) { toast.error("The receipt must be a JPG, PNG, WebP, GIF or PDF"); return; }
    if (file.size > 10 * 1024 * 1024) { toast.error("The receipt must be 10 MB or smaller"); return; }
    setUploading(true);
    try {
      setReceipt(await uploadCommissionReceipt(file));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not upload the receipt");
    } finally {
      setUploading(false);
    }
  };
  // The receipt dropped on the dialog or pasted, as well as picked (2026-10-21).
  const receiptDrop = useFileDrop({
    onFiles: ([f]) => { if (f) void pickFile(f); },
    accept: "image/jpeg,image/png,image/webp,image/gif,application/pdf",
    disabled: !pick || uploading || !!receipt,
  });

  const submit = async () => {
    if (!pick || !receipt) return;
    try {
      const res = await pay.mutateAsync({
        crm: pick.crm.code, month, userId: pick.person.userId, ...payout, category: cat.value.category, subcategory: cat.value.subcategory || undefined,
        departmentId: department === NO_DEPARTMENT ? "" : department,
        receipt: { name: receipt.name, key: receipt.key, size: receipt.size, mimeType: receipt.mimeType },
      });
      toast.success(`Paid — ${res.expense.expenseNumber} recorded with the receipt`);
      close();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not record the payment");
    }
  };

  const amount = pick?.person.payout?.amountMinor ?? 0;
  return (
    <Dialog open={!!pick} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Mark commission paid</DialogTitle>
          <DialogDescription>
            {pick ? `${pick.person.name} · ${pick.crm.name} · ${monthLabel(month)} — ${money(amount, pick.crm.currency)}, as approved by ${pick.person.payout?.approvedByName ?? "a manager"}. It is recorded as a paid expense with the receipt.` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-3">
          <PayoutFields value={payout} onChange={setPayout} idPrefix="crm-commission" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <CategoryPicker categories={categoryList} value={cat.value} onChange={cat.set} idPrefix="crm-commission" loading={categories.isLoading} />
          <div className="space-y-1.5">
            <Label htmlFor="crm-commission-department">Department (optional)</Label>
            <Select value={department} onValueChange={setDepartment} disabled={departments.isLoading}>
              <SelectTrigger id="crm-commission-department"><SelectValue placeholder="No department" /></SelectTrigger>
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
          <Button loading={pay.isPending} disabled={!receipt || uploading || !cat.complete || !payoutValid(payout)} onClick={() => void submit()}>
            <Wallet className="h-4 w-4" /> Mark paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
