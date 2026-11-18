"use client";

import { referenceNeeded, referenceProblem, type ExpensePaymentMethod } from "@delta/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The methods an expense can be paid by, as they read on screen. */
export const PAYOUT_METHOD_LABELS: Record<ExpensePaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  cash: "Cash",
  cheque: "Cheque",
  card: "Card",
  online: "Online",
};

export interface Payout {
  paidOn: string;
  paymentMethod: ExpensePaymentMethod;
  reference: string;
}

export const todayIso = () => new Date().toISOString().slice(0, 10);
export const emptyPayout = (): Payout => ({ paidOn: todayIso(), paymentMethod: "bank_transfer", reference: "" });

/**
 * When, how, and the bank or cheque reference — what "Mark paid" records on
 * the expense for a salary advance or a one-time payment from HRMS. The date
 * cannot be in the future: this records money that has gone.
 */
export function PayoutFields({ value, onChange, idPrefix }: { value: Payout; onChange: (v: Payout) => void; idPrefix: string }) {
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-paid-on`}>Paid on</Label>
        <Input id={`${idPrefix}-paid-on`} type="date" max={todayIso()} value={value.paidOn}
          onChange={(e) => onChange({ ...value, paidOn: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-method`}>Paid by</Label>
        <Select value={value.paymentMethod} onValueChange={(m) => onChange({ ...value, paymentMethod: m as ExpensePaymentMethod })}>
          <SelectTrigger id={`${idPrefix}-method`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(PAYOUT_METHOD_LABELS) as ExpensePaymentMethod[]).map((m) => (
              <SelectItem key={m} value={m}>{PAYOUT_METHOD_LABELS[m]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        {/* Required unless paid in cash (2026-11-18). */}
        <Label htmlFor={`${idPrefix}-ref`}>
          Reference {referenceNeeded(value.paymentMethod)
            ? <span className="text-danger">*</span>
            : <span className="font-normal text-foreground-muted">(not needed for cash)</span>}
        </Label>
        <Input id={`${idPrefix}-ref`} value={value.reference} maxLength={120} placeholder="Bank or cheque reference"
          onChange={(e) => onChange({ ...value, reference: e.target.value })} />
      </div>
    </>
  );
}

/** A payout that can be sent: its date set and not after today, and its reference unless paid in cash. */
export const payoutValid = (p: Payout) =>
  /^\d{4}-\d{2}-\d{2}$/.test(p.paidOn) && p.paidOn <= todayIso() && !referenceProblem(p.paymentMethod, p.reference);
