"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Landmark } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { useCreateLoan } from "@/features/loans/api";

function today() { return new Date().toISOString().slice(0, 10); }

export default function NewLoanPage() {
  const router = useRouter();
  const { mutate, isPending } = useCreateLoan();

  const [type, setType] = useState<"taken" | "given">("taken");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyType, setCounterpartyType] = useState<"customer" | "vendor" | "other">("other");
  const [principalAED, setPrincipalAED] = useState("");
  const [interestRate, setInterestRate] = useState("");
  const [interestType, setInterestType] = useState<"simple" | "compound">("simple");
  const [startDate, setStartDate] = useState(today());
  const [dueDate, setDueDate] = useState("");
  const [repaymentFrequency, setRepaymentFrequency] = useState<
    "monthly" | "quarterly" | "annually" | "bullet" | "none"
  >("monthly");
  const [notes, setNotes] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    mutate(
      {
        type,
        counterpartyName,
        counterpartyType,
        principalMinor: Math.round(parseFloat(principalAED) * 100),
        interestRate: parseFloat(interestRate) || 0,
        interestType,
        startDate,
        dueDate: dueDate || undefined,
        repaymentFrequency,
        notes,
      },
      { onSuccess: (loan) => router.push(`/loans/${loan.id}`) },
    );
  }

  const isValid = counterpartyName.trim() && parseFloat(principalAED) > 0;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Landmark}
        title="New Loan"
        description="Record a loan taken from or given to a counterparty."
      />

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
        {/* Type toggle */}
        <div className="space-y-1.5">
          <Label>Loan Type</Label>
          <div className="grid grid-cols-2 gap-2">
            {(["taken", "given"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                  type === t
                    ? t === "taken"
                      ? "border-danger/50 bg-danger/10 text-danger"
                      : "border-success/50 bg-success/10 text-success"
                    : "border-border bg-surface text-foreground-muted hover:bg-surface-muted"
                }`}
              >
                {t === "taken" ? "Loan Taken (borrowed)" : "Loan Given (lent out)"}
              </button>
            ))}
          </div>
          <p className="text-xs text-foreground-subtle">
            {type === "taken"
              ? "Your organization received funds from a lender."
              : "Your organization disbursed funds to a borrower."}
          </p>
        </div>

        {/* Counterparty */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cpName">
              {type === "taken" ? "Lender Name" : "Borrower Name"}
            </Label>
            <Input
              id="cpName"
              value={counterpartyName}
              onChange={(e) => setCounterpartyName(e.target.value)}
              placeholder="Name or institution"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Counterparty Type</Label>
            <Select value={counterpartyType} onValueChange={(v) => setCounterpartyType(v as typeof counterpartyType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="customer">Customer</SelectItem>
                <SelectItem value="vendor">Vendor</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Principal + interest */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5 sm:col-span-1">
            <Label htmlFor="principal">Principal Amount (AED)</Label>
            <Input
              id="principal"
              type="number"
              step="0.01"
              min="0.01"
              value={principalAED}
              onChange={(e) => setPrincipalAED(e.target.value)}
              placeholder="100,000.00"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rate">Annual Interest Rate (%)</Label>
            <Input
              id="rate"
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={interestRate}
              onChange={(e) => setInterestRate(e.target.value)}
              placeholder="5.00"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Interest Type</Label>
            <Select value={interestType} onValueChange={(v) => setInterestType(v as typeof interestType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="simple">Simple</SelectItem>
                <SelectItem value="compound">Compound (monthly)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Dates + frequency */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Start Date</Label>
            <DatePicker value={startDate} onChange={setStartDate} />
          </div>
          <div className="space-y-1.5">
            <Label>Due / Maturity Date</Label>
            <DatePicker value={dueDate} onChange={setDueDate} placeholder="No fixed maturity" />
          </div>
          <div className="space-y-1.5">
            <Label>Repayment Frequency</Label>
            <Select
              value={repaymentFrequency}
              onValueChange={(v) => setRepaymentFrequency(v as typeof repaymentFrequency)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
                <SelectItem value="annually">Annually</SelectItem>
                <SelectItem value="bullet">Bullet (lump sum at end)</SelectItem>
                <SelectItem value="none">No fixed schedule</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Notes */}
        <div className="space-y-1.5">
          <Label htmlFor="notes">Notes</Label>
          <textarea
            id="notes"
            className="w-full rounded-md border border-border bg-surface p-2.5 text-sm text-foreground placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes…"
          />
        </div>

        {/* Preview */}
        {principalAED && parseFloat(principalAED) > 0 && (
          <div className="rounded-lg border border-border bg-surface-muted p-4 text-sm">
            <p className="font-medium text-foreground">Summary</p>
            <div className="mt-2 grid grid-cols-2 gap-x-8 gap-y-1 text-foreground-muted">
              <span>Type:</span>
              <span className="font-medium capitalize">{type}</span>
              <span>{type === "taken" ? "Lender" : "Borrower"}:</span>
              <span className="font-medium">{counterpartyName || "—"}</span>
              <span>Principal:</span>
              <span className="font-medium">
                AED {parseFloat(principalAED || "0").toLocaleString("en-AE", { minimumFractionDigits: 2 })}
              </span>
              <span>Rate:</span>
              <span className="font-medium">
                {interestRate ? `${interestRate}% p.a. (${interestType})` : "0% (interest-free)"}
              </span>
              {dueDate && (
                <>
                  <span>Due:</span>
                  <span className="font-medium">{dueDate}</span>
                </>
              )}
            </div>
          </div>
        )}

        <div className="flex gap-3">
          <Button type="submit" disabled={isPending || !isValid}>
            {isPending ? "Saving…" : "Create Loan"}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
