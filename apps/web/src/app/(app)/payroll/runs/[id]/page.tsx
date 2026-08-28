"use client";

import { Fragment, use, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, Wallet, PauseCircle, TrendingUp, Plus, X, Info,
  CheckCircle2, Banknote, Undo2, RefreshCw, AlertTriangle,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MoneyDisplay } from "@/components/ui/money";
import {
  usePayrollRun, useAddAdjustments, usePullCommissions, useRemoveAdjustment,
  useApproveRun, useReturnRun, usePayRun, useRetrySync, useReversePayment,
} from "@/features/payroll/api";
import { AdjustDialog } from "@/features/payroll/adjust-dialog";
import { PayDialog } from "@/features/payroll/pay-dialog";
import { ReasonDialog } from "@/features/payroll/reason-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { RUN_STATUS_LABELS, type LineStatus, type RunLine, type RunStatus } from "@/features/payroll/types";
import { Button } from "@/components/ui/button";

const RUN_TONE: Record<RunStatus, "success" | "warning" | "neutral" | "danger" | "primary"> = {
  imported: "primary", additions: "primary", approved: "warning",
  partially_paid: "warning", paid: "success", returned: "danger", voided: "neutral",
};

const LINE_TONE: Record<LineStatus, "success" | "warning" | "neutral" | "danger"> = {
  pending: "neutral", on_hold: "danger", partially_paid: "warning", paid: "success",
};

const LINE_LABEL: Record<LineStatus, string> = {
  pending: "To pay", on_hold: "Held", partially_paid: "Part paid", paid: "Paid",
};

export default function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: run, isLoading } = usePayrollRun(id);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<RunLine | null>(null);
  const [paying, setPaying] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);
  const [reversing, setReversing] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const addAdjustments = useAddAdjustments(id);
  const pullCommissions = usePullCommissions(id);
  const removeAdjustment = useRemoveAdjustment(id);
  const approve = useApproveRun(id);
  const returnRun = useReturnRun(id);
  const pay = usePayRun(id);
  const retrySync = useRetrySync(id);
  const reverse = useReversePayment(id);

  // What HRMS actually did, once it has told us. Adding money can move net pay
  // by a different amount, so this is shown rather than assumed.
  const notes = addAdjustments.data?.notes ?? pullCommissions.data?.notes ?? [];

  const lines = useMemo(() => {
    if (!run) return [];
    const q = search.trim().toLowerCase();
    if (!q) return run.lines;
    return run.lines.filter(
      (l) => l.name.toLowerCase().includes(q) || l.employeeCode.toLowerCase().includes(q),
    );
  }, [run, search]);

  if (isLoading) return <p className="text-sm text-foreground-muted">Loading…</p>;
  if (!run) return <p className="text-sm text-danger">Payroll run not found.</p>;

  // Only while accounts still own the figures. Once a run is approved or paid,
  // changing a payslip underneath it would put the payslip and the transfer out
  // of step — which is the whole thing this handover exists to prevent.
  const openForAdjustment = run.status === "imported" || run.status === "additions";
  const canApprove = openForAdjustment && run.lines.length > 0;
  const canPay = run.status === "approved" || run.status === "partially_paid";
  // A payment the money left the bank for but HRMS never acknowledged. The one
  // disagreement between the two systems that must never be quiet.
  const unsynced = run.payments.filter((p) => !p.syncedToHrms);
  const adjustmentsByLine = new Map<string, typeof run.adjustments>();
  for (const a of run.adjustments) {
    if (!adjustmentsByLine.has(a.lineId)) adjustmentsByLine.set(a.lineId, []);
    adjustmentsByLine.get(a.lineId)!.push(a);
  }

  return (
    <div className="space-y-6">
      <Link href="/payroll/runs" className="inline-flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />All payroll runs
      </Link>

      <PageHeader
        icon={Wallet}
        title={`${run.runNumber} · ${run.period}`}
        description={`From ${run.hrmsOrgName}. Imported ${run.importedAt ? new Date(run.importedAt).toLocaleDateString() : ""}${run.importedByName ? ` by ${run.importedByName}` : ""}.`}
        action={<Badge tone={RUN_TONE[run.status]}>{RUN_STATUS_LABELS[run.status]}</Badge>}
      />

      {/* Six tiles wrapped to a second row with one lonely card on it.
          Outstanding only differs from payable once something has been paid, so
          it earns its place then and not before. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="People" value={String(run.totals.employeeCount)} />
        <Stat label="Gross" value={<MoneyDisplay minor={run.totals.hrmsGrossMinor} currency={run.currency} />} />
        <Stat label="Deductions" value={<MoneyDisplay minor={run.totals.hrmsDeductionsMinor} currency={run.currency} />} />
        {run.totals.adjustmentsMinor !== 0 && (
          <Stat label="Adjustments" value={<MoneyDisplay minor={run.totals.adjustmentsMinor} currency={run.currency} />} />
        )}
        <Stat label="Payable" value={<MoneyDisplay minor={run.totals.payableMinor} currency={run.currency} />} strong />
        {run.totals.amountPaidMinor > 0 && (
          <Stat label="Outstanding" value={<MoneyDisplay minor={run.totals.balanceMinor} currency={run.currency} />} />
        )}
      </div>

      {unsynced.length > 0 && (
        <Card className="space-y-2 border-danger/20 bg-danger/5 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium text-danger">
            <AlertTriangle className="h-4 w-4" />Paid here, but HRMS was not told
          </p>
          {unsynced.map((p) => (
            <div key={p.paymentId} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">
                {p.paymentId} · <MoneyDisplay minor={p.amountMinor} currency={run.currency} /> ·{" "}
                <span className="text-foreground-muted">{p.syncError}</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                loading={retrySync.isPending}
                onClick={() => retrySync.mutate(p.paymentId)}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />Retry
              </Button>
            </div>
          ))}
          <p className="text-xs text-foreground-muted">
            The transfer happened and is recorded here. Employees still see their payslips as issued
            until this succeeds. Retrying is safe — nothing will be paid twice.
          </p>
        </Card>
      )}

      {(canApprove || canPay) && (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">{canPay ? "Ready to pay" : "Sign off"}</p>
            <p className="text-foreground-muted">
              {canPay
                ? selected.size > 0
                  ? `${selected.size} selected. Leave nothing selected to pay everybody still owed.`
                  : "Everybody still owed will be paid. Held people are always excluded."
                : "Approving locks the figures and tells HR the month is final."}
            </p>
          </div>
          {canApprove && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setSendingBack(true)}>
                <Undo2 className="mr-1.5 h-3.5 w-3.5" />Send back to HR
              </Button>
              <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate()}>
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Approve
              </Button>
            </>
          )}
          {canPay && (
            <Button size="sm" onClick={() => setPaying(true)}>
              <Banknote className="mr-1.5 h-3.5 w-3.5" />Record payment
            </Button>
          )}
        </Card>
      )}

      {pay.data && (
        <Card className="space-y-1 border-success/20 bg-success/5 p-4 text-sm">
          <p className="font-medium text-success">
            {pay.data.paymentId} · {pay.data.amountFormatted} to {pay.data.paidCount} people.
          </p>
          {pay.data.commissionsSettled > 0 && (
            <p>{pay.data.commissionsSettled} commission record(s) settled through this payroll.</p>
          )}
          {pay.data.warning && <p className="text-danger">{pay.data.warning}</p>}
        </Card>
      )}

      {(approve.isError || pay.isError || returnRun.isError) && (
        <Card className="border-danger/20 bg-danger/5 p-4 text-sm text-danger">
          {((approve.error ?? pay.error ?? returnRun.error) as Error).message}
        </Card>
      )}

      {openForAdjustment && (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">Additions and deductions</p>
            <p className="text-foreground-muted">
              Everything added here is written to the payslip in HRMS, so the employee sees the same
              figure that is paid.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={pullCommissions.isPending}
            onClick={() => pullCommissions.mutate()}
          >
            <TrendingUp className="mr-1.5 h-3.5 w-3.5" />Pull earned commission
          </Button>
        </Card>
      )}

      {pullCommissions.data && (
        <p className="text-sm text-foreground-muted">{pullCommissions.data.message}</p>
      )}
      {(addAdjustments.isError || pullCommissions.isError || removeAdjustment.isError) && (
        <Card className="border-danger/20 bg-danger/5 p-4 text-sm text-danger">
          {((addAdjustments.error ?? pullCommissions.error ?? removeAdjustment.error) as Error).message}
        </Card>
      )}

      {notes.length > 0 && (
        <Card className="space-y-1.5 border-warning/20 bg-warning/5 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium text-warning">
            <Info className="h-4 w-4" />What actually happened
          </p>
          {notes.map((n) => <p key={n} className="text-foreground">{n}</p>)}
        </Card>
      )}

      {run.totals.heldCount > 0 && (
        <Card className="flex items-start gap-2 border-danger/20 bg-danger/5 p-4 text-sm">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <p>
            <span className="font-medium text-danger">{run.totals.heldCount} person(s) are held</span> — there
            is nowhere to send their money. They are excluded from payment until HR adds bank details and the
            month is re-synced, so they cannot be swept into a bulk transfer and counted as paid.
          </p>
        </Card>
      )}

      {run.payments.length > 0 && (
        <Card>
          <div className="border-b border-border px-5 py-3 text-sm font-medium">Payments</div>
          <div className="divide-y divide-border">
            {run.payments.map((p) => (
              <div key={p.paymentId} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {p.paymentId} · <MoneyDisplay minor={p.amountMinor} currency={run.currency} />
                  </div>
                  <div className="text-xs text-foreground-muted">
                    {new Date(p.paidOn).toLocaleDateString()} · {p.bankAccountName || p.method} ·{" "}
                    {p.payslipCount} people{p.reference ? ` · ${p.reference}` : ""}
                    {p.reversalReason ? ` · reversed: ${p.reversalReason}` : ""}
                  </div>
                </div>
                {p.reversedAt ? (
                  <Badge tone="neutral">Reversed</Badge>
                ) : p.syncedToHrms ? (
                  <Badge tone="success">Confirmed by HRMS</Badge>
                ) : (
                  <Badge tone="danger">Not in HRMS</Badge>
                )}
                {!p.reversedAt && (
                  <Button size="sm" variant="ghost" onClick={() => setReversing(p.paymentId)}>
                    <Undo2 className="mr-1.5 h-3.5 w-3.5" />Reverse
                  </Button>
                )}
              </div>
            ))}
          </div>
          {reverse.data && (
            <p className="border-t border-border px-5 py-3 text-sm text-foreground-muted">
              {reverse.data.message}
              {reverse.data.commissionsReopened > 0 &&
                ` · ${reverse.data.commissionsReopened} commission record(s) returned to unpaid.`}
            </p>
          )}
          {reverse.isError && (
            <p className="border-t border-border px-5 py-3 text-sm text-danger">
              {(reverse.error as Error).message}
            </p>
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <Input
            placeholder="Search name or code"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-64"
          />
          <span className="ml-auto text-xs text-foreground-muted">{lines.length} of {run.lines.length}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
              <tr>
                {canPay && <th className="w-10 px-5 py-3" />}
                <th className="px-5 py-3 font-medium">Employee</th>
                <th className="px-5 py-3 font-medium">Department</th>
                <th className="px-5 py-3 text-right font-medium">Gross</th>
                <th className="px-5 py-3 text-right font-medium">Deductions</th>
                <th className="px-5 py-3 text-right font-medium">Payable</th>
                <th className="px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                // Fragment, not <>, because the key has to live on the element
                // that is actually the list child — the shorthand cannot take one.
                <Fragment key={l.id}>
                  <tr
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-muted"
                    onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                  >
                    {canPay && (
                      <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
                        {/* Nothing to tick for somebody who cannot be paid.
                            A disabled box invites clicking it and wondering. */}
                        {l.status === "on_hold" || l.status === "paid" ? (
                          <span className="block h-4 w-4" aria-hidden />
                        ) : (
                          <Checkbox
                            checked={selected.has(l.id)}
                            onChange={() =>
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(l.id)) next.delete(l.id); else next.add(l.id);
                                return next;
                              })
                            }
                            aria-label={`Select ${l.name}`}
                          />
                        )}
                      </td>
                    )}
                    <td className="px-5 py-3">
                      <div className="font-medium">{l.name}</div>
                      <div className="text-xs text-foreground-muted">
                        {l.employeeCode}{l.designation ? ` · ${l.designation}` : ""}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-foreground-muted">{l.departmentName || "—"}</td>
                    <td className="px-5 py-3 text-right"><MoneyDisplay minor={l.grossMinor} currency={run.currency} /></td>
                    <td className="px-5 py-3 text-right"><MoneyDisplay minor={l.deductionsMinor} currency={run.currency} /></td>
                    <td className="px-5 py-3 text-right font-medium"><MoneyDisplay minor={l.payableMinor} currency={run.currency} /></td>
                    <td className="px-5 py-3">
                      <Badge tone={LINE_TONE[l.status]}>{LINE_LABEL[l.status]}</Badge>
                      {l.holdReason && <div className="mt-1 text-xs text-danger">{l.holdReason}</div>}
                    </td>
                  </tr>
                  {expanded === l.id && (
                    <tr className="border-b border-border bg-surface-muted/50">
                      <td colSpan={canPay ? 7 : 6} className="px-5 py-4">
                        <div className="grid gap-6 sm:grid-cols-2">
                          <Breakdown title="Earnings" items={l.earnings} currency={run.currency} />
                          <Breakdown title="Deductions" items={l.deductions} currency={run.currency} />
                        </div>

                        {(adjustmentsByLine.get(l.id) ?? []).length > 0 && (
                          <div className="mt-4">
                            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-foreground-muted">
                              Added by accounts
                            </p>
                            <ul className="space-y-1">
                              {(adjustmentsByLine.get(l.id) ?? []).map((a) => (
                                <li key={a.externalId} className="flex items-center justify-between gap-2 text-sm">
                                  <span>
                                    {a.kind === "deduction" ? "−" : "+"} {a.label}
                                    {a.source === "commission" && (
                                      <Badge tone="primary" className="ml-2">Commission</Badge>
                                    )}
                                    {a.outstandingMinor > 0 && (
                                      <span className="ml-2 text-xs text-warning">
                                        only <MoneyDisplay minor={a.recoveredMinor} currency={run.currency} /> recovered,{" "}
                                        <MoneyDisplay minor={a.outstandingMinor} currency={run.currency} /> carried forward
                                      </span>
                                    )}
                                  </span>
                                  <span className="flex items-center gap-2">
                                    <MoneyDisplay minor={a.amountMinor} currency={run.currency} />
                                    {openForAdjustment && (
                                      <button
                                        type="button"
                                        aria-label={`Remove ${a.label}`}
                                        className="text-foreground-muted hover:text-danger"
                                        onClick={(e) => { e.stopPropagation(); removeAdjustment.mutate(a.externalId); }}
                                      >
                                        <X className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {openForAdjustment && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="mt-4"
                            onClick={(e) => { e.stopPropagation(); setAdjusting(l); }}
                          >
                            <Plus className="mr-1.5 h-3.5 w-3.5" />Add or deduct
                          </Button>
                        )}
                        <p className="mt-3 text-xs text-foreground-muted">
                          {/* Enough to tell one account from another without
                              putting a full IBAN on screen for a passer-by. */}
                          {l.bank.bankName || "No bank"}
                          {l.bank.iban ? ` · ${l.bank.iban.slice(0, 4)}…${l.bank.iban.slice(-4)}` : ""}
                          {l.bank.nameInBank ? ` · ${l.bank.nameInBank}` : ""}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {lines.length === 0 && (
                <tr><td colSpan={canPay ? 7 : 6} className="px-5 py-10 text-center text-foreground-muted">Nothing matches that search.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <ReasonDialog
        open={sendingBack}
        onOpenChange={setSendingBack}
        title={`Send ${run.runNumber} back to HR?`}
        description="The month unlocks on their side so they can correct it, and comes back to you when they resubmit."
        label="What needs fixing?"
        placeholder="Nadia Okafor has no bank details"
        confirmLabel="Send back"
        pending={returnRun.isPending}
        onConfirm={(reason) => returnRun.mutate(reason, { onSuccess: () => setSendingBack(false) })}
      />

      <ReasonDialog
        open={Boolean(reversing)}
        onOpenChange={(o) => { if (!o) setReversing(null); }}
        title="Reverse this payment?"
        description="The money goes back on the bank account, the payslips return to issued, any commission it settled is owed again, and the expense is voided."
        label="Why is it being reversed?"
        placeholder="Bank returned the transfer — closed account"
        confirmLabel="Reverse payment"
        destructive
        pending={reverse.isPending}
        onConfirm={(reason) =>
          reversing && reverse.mutate({ paymentId: reversing, reason }, { onSuccess: () => setReversing(null) })
        }
      />

      <PayDialog
        open={paying}
        onOpenChange={setPaying}
        lines={run.lines}
        selectedIds={Array.from(selected)}
        currency={run.currency}
        pending={pay.isPending}
        onSubmit={(input) =>
          pay.mutate(input, { onSuccess: () => { setPaying(false); setSelected(new Set()); } })
        }
      />

      <AdjustDialog
        line={adjusting}
        currency={run.currency}
        open={Boolean(adjusting)}
        onOpenChange={(o) => { if (!o) setAdjusting(null); }}
        pending={addAdjustments.isPending}
        onSubmit={(item) =>
          addAdjustments.mutate([item], { onSuccess: () => setAdjusting(null) })
        }
      />
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <Card className="p-4">
      <div className={strong ? "text-lg font-semibold" : "text-lg"}>{value}</div>
      <div className="mt-0.5 text-xs text-foreground-muted">{label}</div>
    </Card>
  );
}

function Breakdown({
  title, items, currency,
}: { title: string; items: Array<{ label: string; amountMinor: number }>; currency: string }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-foreground-muted">{title}</p>
      {items.length === 0 ? (
        <p className="text-sm text-foreground-muted">None</p>
      ) : (
        <ul className="space-y-1">
          {items.map((i, idx) => (
            <li key={`${i.label}-${idx}`} className="flex justify-between text-sm">
              <span>{i.label}</span>
              <MoneyDisplay minor={i.amountMinor} currency={currency} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
