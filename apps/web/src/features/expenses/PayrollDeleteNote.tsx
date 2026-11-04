"use client";

import Link from "next/link";
import { formatMoney } from "@delta/shared";
import { Textarea } from "@/components/ui/textarea";
import type { PayrollPaymentOfExpense } from "./api";

/**
 * What deleting an expense a payroll payment posted takes with it (the user, 2026-11-04: "delete it from its connected
 * areas also") — the payment, its two bank lines, and, when the payment still stands, reversing it first: for that, a
 * reason. Shown in both delete dialogs; the dialog's Delete waits on `ready`.
 */
export function PayrollDeleteNote({ payroll, reason, onReason }: {
  payroll: PayrollPaymentOfExpense;
  reason: string;
  onReason: (v: string) => void;
}) {
  const who = payroll.people.length <= 4 ? payroll.people.join(", ") : `${payroll.people.slice(0, 3).join(", ")} and ${payroll.people.length - 3} more`;
  return (
    <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
      <p>
        Posted by payroll payment{" "}
        <Link href={`/payroll/runs/${payroll.runId}`} className="font-medium text-primary hover:underline">{payroll.paymentId}</Link>{" "}
        ({payroll.period}, {formatMoney(payroll.amountMinor, payroll.currency)}, {who || "nobody"}). Deleting it also:
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-foreground-muted">
        {!payroll.reversed && (
          <li>
            <span className="font-medium text-foreground">reverses the payment first</span> — {who || "they"} owed again on the run,
            their payslips back to issued in HRMS, any commission it settled open again;
          </li>
        )}
        <li>removes its lines in {payroll.reversed ? "the bank (out and back in)" : "the bank"} — the balance ends as if it was never paid;</li>
        <li>takes the payment off the run (the run keeps a note of it).</li>
      </ul>
      {payroll.reconciled && (
        <p className="text-danger">Its bank line has been reconciled against a statement, so it can&apos;t be deleted.</p>
      )}
      {!payroll.reversed && !payroll.reconciled && (
        <Textarea
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          placeholder="Why? e.g. Recorded twice — the transfer never went"
          rows={2}
          maxLength={500}
        />
      )}
    </div>
  );
}

/** Whether Delete may go: nothing to say for an ordinary expense; a reason when a standing payment is reversed first. */
export function payrollDeleteReady(payroll: PayrollPaymentOfExpense | null | undefined, reason: string): boolean {
  if (!payroll) return true;
  if (payroll.reconciled) return false;
  return payroll.reversed || reason.trim().length >= 3;
}
