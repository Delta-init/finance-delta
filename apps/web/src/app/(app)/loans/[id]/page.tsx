"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Landmark, CheckCircle2, XCircle, Trash2, ChevronDown, ChevronUp,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { DatePicker } from "@/components/ui/date-picker";
import {
  useLoan,
  useRepayments,
  useRecordRepayment,
  useDeleteRepayment,
  useUpdateLoan,
} from "@/features/loans/api";

function today() { return new Date().toISOString().slice(0, 10); }

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  active: "warning",
  closed: "success",
  defaulted: "danger",
};

export default function LoanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const { data: loan, isLoading } = useLoan(id);
  const { data: repayments, isLoading: repsLoading } = useRepayments(id);
  const { mutate: recordRepayment, isPending: recording } = useRecordRepayment(id);
  const { mutate: deleteRepayment } = useDeleteRepayment(id);
  const { mutate: updateLoan } = useUpdateLoan();

  const [showForm, setShowForm] = useState(false);
  const [paidOn, setPaidOn] = useState(today());
  const [principalAED, setPrincipalAED] = useState("");
  const [interestAED, setInterestAED] = useState("");
  const [notes, setNotes] = useState("");

  function handleRecordRepayment(e: React.FormEvent) {
    e.preventDefault();
    recordRepayment(
      {
        paidOn,
        principalMinor: Math.round(parseFloat(principalAED || "0") * 100),
        interestMinor: Math.round(parseFloat(interestAED || "0") * 100),
        notes,
      },
      {
        onSuccess: () => {
          setShowForm(false);
          setPrincipalAED("");
          setInterestAED("");
          setNotes("");
        },
      },
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-surface-muted" />
        ))}
      </div>
    );
  }

  if (!loan) return null;

  const progressPct = loan.principalMinor > 0
    ? Math.min(100, (loan.totalRepaidPrincipalMinor / loan.principalMinor) * 100)
    : 0;

  const isClosed = loan.status === "closed";
  const suggestedInterest = loan.accruedInterestMinor > 0
    ? (loan.accruedInterestMinor / 100).toFixed(2)
    : "0.00";

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Landmark}
        title={loan.loanNumber}
        description={`${loan.type === "taken" ? "Borrowed from" : "Lent to"} ${loan.counterpartyName}`}
        action={
          !isClosed ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => updateLoan({ id, input: { status: "closed" } })}
              >
                <CheckCircle2 className="h-4 w-4" /> Close Loan
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => updateLoan({ id, input: { status: "defaulted" } })}
                className="text-danger border-danger/30 hover:bg-danger/5"
              >
                <XCircle className="h-4 w-4" /> Mark Defaulted
              </Button>
            </div>
          ) : undefined
        }
      />

      {/* Status + badges */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[loan.status]} className="capitalize">{loan.status}</Badge>
        <Badge tone={loan.type === "taken" ? "danger" : "success"} className="capitalize">
          {loan.type}
        </Badge>
        <Badge tone="neutral">{loan.interestRate}% p.a. {loan.interestType}</Badge>
        <Badge tone="neutral" className="capitalize">{loan.repaymentFrequency} repayments</Badge>
        {loan.dueDate && (
          <Badge tone={new Date(loan.dueDate) < new Date() && !isClosed ? "danger" : "neutral"}>
            Due {loan.dueDate}
          </Badge>
        )}
      </div>

      {/* Key numbers */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Principal", value: loan.principalMinor, className: "" },
          { label: "Outstanding Principal", value: loan.outstandingPrincipalMinor, className: "text-warning font-semibold" },
          { label: "Accrued Interest", value: loan.accruedInterestMinor, className: "text-danger" },
          { label: "Total Owed", value: loan.netOwedMinor, className: "text-foreground font-bold" },
        ].map(({ label, value, className }) => (
          <div key={label} className="rounded-xl border border-border bg-surface p-4">
            <p className="text-xs text-foreground-muted">{label}</p>
            <MoneyDisplay minor={value} className={`mt-1 text-lg ${className}`} />
          </div>
        ))}
      </div>

      {/* Repayment progress */}
      <div className="rounded-xl border border-border bg-surface p-5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Principal Repaid</span>
          <span className="text-sm text-foreground-muted">
            {progressPct.toFixed(1)}% ({loan.totalRepaidPrincipalMinor > 0 && (
              <MoneyDisplay minor={loan.totalRepaidPrincipalMinor} className="inline" />
            )}{" "}
            of <MoneyDisplay minor={loan.principalMinor} className="inline" />)
          </span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-surface-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        {loan.totalRepaidInterestMinor > 0 && (
          <p className="text-xs text-foreground-muted">
            Interest paid: <MoneyDisplay minor={loan.totalRepaidInterestMinor} className="inline" />
          </p>
        )}
        {loan.startDate && (
          <p className="text-xs text-foreground-subtle">Started {loan.startDate}</p>
        )}
      </div>

      {/* Record repayment form */}
      {!isClosed && (
        <div className="rounded-xl border border-border bg-surface">
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="flex w-full items-center justify-between p-4 text-left"
          >
            <span className="font-medium">Record a Repayment</span>
            {showForm ? (
              <ChevronUp className="h-4 w-4 text-foreground-muted" />
            ) : (
              <ChevronDown className="h-4 w-4 text-foreground-muted" />
            )}
          </button>

          {showForm && (
            <form onSubmit={handleRecordRepayment} className="border-t border-border p-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>Payment Date</Label>
                  <DatePicker value={paidOn} onChange={setPaidOn} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="repPrincipal">Principal Amount (AED)</Label>
                  <Input
                    id="repPrincipal"
                    type="number"
                    step="0.01"
                    min="0"
                    value={principalAED}
                    onChange={(e) => setPrincipalAED(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="repInterest">
                    Interest Amount (AED)
                    {loan.accruedInterestMinor > 0 && (
                      <button
                        type="button"
                        className="ml-2 text-xs text-primary underline"
                        onClick={() => setInterestAED(suggestedInterest)}
                      >
                        use accrued ({suggestedInterest})
                      </button>
                    )}
                  </Label>
                  <Input
                    id="repInterest"
                    type="number"
                    step="0.01"
                    min="0"
                    value={interestAED}
                    onChange={(e) => setInterestAED(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="repNotes">Notes</Label>
                <Input
                  id="repNotes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional…"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={
                    recording ||
                    (parseFloat(principalAED || "0") === 0 && parseFloat(interestAED || "0") === 0)
                  }
                >
                  {recording ? "Saving…" : "Record Payment"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Repayment history */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Repayment History</h2>
        {repsLoading ? (
          <div className="h-20 animate-pulse rounded-xl bg-surface-muted" />
        ) : !repayments?.length ? (
          <p className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-foreground-muted">
            No repayments recorded yet.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-muted">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-foreground-muted">Date</th>
                  <th className="px-4 py-3 text-right font-medium text-foreground-muted">Principal</th>
                  <th className="px-4 py-3 text-right font-medium text-foreground-muted">Interest</th>
                  <th className="px-4 py-3 text-right font-medium text-foreground-muted">Total</th>
                  <th className="px-4 py-3 text-left font-medium text-foreground-muted">Notes</th>
                  {!isClosed && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {repayments.map((r) => (
                  <tr key={r.id} className="bg-surface hover:bg-surface-muted/50">
                    <td className="px-4 py-3 font-mono text-sm">{r.paidOn}</td>
                    <td className="px-4 py-3 text-right">
                      <MoneyDisplay minor={r.principalMinor} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.interestMinor > 0 ? (
                        <MoneyDisplay minor={r.interestMinor} className="text-danger" />
                      ) : (
                        <span className="text-foreground-subtle">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">
                      <MoneyDisplay minor={r.totalMinor} />
                    </td>
                    <td className="px-4 py-3 text-foreground-muted">{r.notes || "—"}</td>
                    {!isClosed && (
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => deleteRepayment(r.id)}
                          className="p-1 text-foreground-subtle hover:text-danger"
                          title="Delete repayment"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-border bg-surface-muted">
                <tr>
                  <td className="px-4 py-2.5 text-xs font-medium text-foreground-muted">Total</td>
                  <td className="px-4 py-2.5 text-right text-sm font-semibold">
                    <MoneyDisplay minor={loan.totalRepaidPrincipalMinor} />
                  </td>
                  <td className="px-4 py-2.5 text-right text-sm font-semibold">
                    <MoneyDisplay minor={loan.totalRepaidInterestMinor} />
                  </td>
                  <td className="px-4 py-2.5 text-right text-sm font-bold">
                    <MoneyDisplay
                      minor={loan.totalRepaidPrincipalMinor + loan.totalRepaidInterestMinor}
                    />
                  </td>
                  <td colSpan={isClosed ? 1 : 2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* Loan notes */}
      {loan.notes && (
        <div className="rounded-lg border border-border bg-surface p-4 text-sm text-foreground-muted">
          <p className="font-medium text-foreground mb-1">Notes</p>
          {loan.notes}
        </div>
      )}
    </div>
  );
}
