"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Landmark } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { useLoan, useUpdateLoan } from "@/features/loans/api";

export default function EditLoanPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: loan, isLoading } = useLoan(id);
  const { mutate, isPending } = useUpdateLoan();
  const [type, setType] = useState<"taken" | "given">("taken");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyType, setCounterpartyType] = useState<"customer" | "vendor" | "other">("other");
  const [principal, setPrincipal] = useState("");
  const [interestRate, setInterestRate] = useState("");
  const [interestType, setInterestType] = useState<"simple" | "compound">("simple");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [frequency, setFrequency] = useState<"monthly" | "quarterly" | "annually" | "bullet" | "none">("monthly");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!loan) return;
    setType(loan.type);
    setCounterpartyName(loan.counterpartyName);
    setCounterpartyType(loan.counterpartyType);
    setPrincipal((loan.principalMinor / 100).toFixed(2));
    setInterestRate(String(loan.interestRate));
    setInterestType(loan.interestType);
    setStartDate(loan.startDate);
    setDueDate(loan.dueDate ?? "");
    setFrequency(loan.repaymentFrequency);
    setNotes(loan.notes);
  }, [loan]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    mutate({
      id,
      input: {
        type,
        counterpartyName,
        counterpartyType,
        principalMinor: Math.round(Number(principal) * 100),
        interestRate: Number(interestRate) || 0,
        interestType,
        startDate,
        dueDate: dueDate || undefined,
        repaymentFrequency: frequency,
        notes,
      },
    }, { onSuccess: () => router.push(`/loans/${id}`) });
  }

  if (isLoading) return <div className="p-6 text-sm text-foreground-muted">Loading loan…</div>;
  if (!loan) return <div className="p-6 text-sm text-foreground-muted">Loan not found.</div>;

  return (
    <div className="space-y-6 p-6">
      <PageHeader icon={Landmark} title={`Edit ${loan.loanNumber}`} description="Update loan terms and counterparty details." />
      <form onSubmit={submit} className="max-w-3xl space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Loan Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as typeof type)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="taken">Loan Taken (borrowed)</SelectItem><SelectItem value="given">Loan Given (lent out)</SelectItem></SelectContent></Select>
          </div>
          <div className="space-y-1.5"><Label>Counterparty Type</Label>
            <Select value={counterpartyType} onValueChange={(v) => setCounterpartyType(v as typeof counterpartyType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="customer">Customer</SelectItem><SelectItem value="vendor">Vendor</SelectItem><SelectItem value="other">Other</SelectItem></SelectContent></Select>
          </div>
          <div className="space-y-1.5"><Label htmlFor="counterparty">Counterparty Name</Label><Input id="counterparty" required value={counterpartyName} onChange={(e) => setCounterpartyName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="principal">Principal (AED)</Label><Input id="principal" type="number" min="0.01" step="0.01" required value={principal} onChange={(e) => setPrincipal(e.target.value)} /><p className="text-xs text-foreground-subtle">Must be at least the principal already repaid ({(loan.totalRepaidPrincipalMinor / 100).toFixed(2)} AED).</p></div>
          <div className="space-y-1.5"><Label htmlFor="rate">Annual Interest Rate (%)</Label><Input id="rate" type="number" min="0" max="100" step="0.01" value={interestRate} onChange={(e) => setInterestRate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Interest Type</Label>
            <Select value={interestType} onValueChange={(v) => setInterestType(v as typeof interestType)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="simple">Simple</SelectItem><SelectItem value="compound">Compound (monthly)</SelectItem></SelectContent></Select>
          </div>
          <div className="space-y-1.5"><Label>Start Date</Label><DatePicker value={startDate} onChange={setStartDate} /></div>
          <div className="space-y-1.5"><Label>Due / Maturity Date</Label><DatePicker value={dueDate} onChange={setDueDate} placeholder="No fixed maturity" /></div>
          <div className="space-y-1.5"><Label>Repayment Frequency</Label>
            <Select value={frequency} onValueChange={(v) => setFrequency(v as typeof frequency)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="monthly">Monthly</SelectItem><SelectItem value="quarterly">Quarterly</SelectItem><SelectItem value="annually">Annually</SelectItem><SelectItem value="bullet">Bullet</SelectItem><SelectItem value="none">None</SelectItem></SelectContent></Select>
          </div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="notes">Notes</Label><textarea id="notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full rounded-md border border-border bg-surface p-2.5 text-sm text-foreground" /></div>
        <div className="flex gap-3"><Button type="submit" disabled={isPending || !counterpartyName.trim() || Number(principal) * 100 < loan.totalRepaidPrincipalMinor}>{isPending ? "Saving…" : "Save Changes"}</Button><Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button></div>
      </form>
    </div>
  );
}
