"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { TetraDeposit } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useDecideTetraDeposit } from "./api";

/**
 * Approving or rejecting a deposit Tetra Commission sent.
 *
 * Approving takes what Tetra Commission's own approval dialog took: the amount
 * that actually arrived (the requested one to start with), the transaction ID
 * it arrived under — which Tetra Commission holds to one request each — and
 * the payment method and MT5 login, which may be corrected. The decision goes
 * back at once, and the answer says whether Tetra Commission took it.
 */

/** Tetra Commission's own list of deposit payment methods. */
const PAYMENT_METHODS = ["AED TRANSFER", "UPI", "CARD PAYMENT", "USDT", "INR TRANSFER", "Cash deposit", "Other"];

const levelLabel = (level: string) => (level === "LEVEL_1" ? "Level 1" : level === "LEVEL_2" ? "Level 2" : level);

export function TetraDepositFacts({ deposit }: { deposit: TetraDeposit }) {
  const rows: [string, string][] = [
    ["Student", [deposit.student.name, deposit.student.code].filter(Boolean).join(" · ")],
    ["Email", deposit.student.email],
    ["Level", levelLabel(deposit.student.level)],
    ["Team", deposit.team],
    ["Payment method", deposit.paymentMethod],
    ["MT5 login", deposit.mt5Login],
    ["Raised by", deposit.requestedBy],
    ["For mentor", deposit.initiatingMentor && deposit.initiatingMentor !== deposit.requestedBy ? deposit.initiatingMentor : ""],
    ["Primary mentor", deposit.primaryMentor],
    ["Meeting by", deposit.meetingMentor],
    ["Requested", deposit.requestedAt ? new Date(deposit.requestedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : ""],
  ];
  return (
    <div className="rounded-lg bg-surface-muted p-3 text-sm">
      <p className="text-lg font-semibold"><MoneyDisplay minor={deposit.amountMinor} currency={deposit.currency} /> <span className="text-xs font-normal text-foreground-muted">requested</span></p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-foreground-muted">{k}</dt>
            <dd className="min-w-0 break-words font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      {deposit.notes && <p className="mt-2 whitespace-pre-wrap text-xs text-foreground-muted">{deposit.notes}</p>}
      {deposit.screenshotUrl ? (
        <a href={deposit.screenshotUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          Open the proof of payment <ExternalLink className="h-3 w-3" />
        </a>
      ) : (
        <p className="mt-2 text-xs text-foreground-muted">No proof of payment was attached.</p>
      )}
    </div>
  );
}

export function TetraDepositReviewDialog({ deposit, onClose }: { deposit: TetraDeposit | null; onClose: () => void }) {
  const decide = useDecideTetraDeposit(deposit?.id ?? "");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [amount, setAmount] = useState("");
  const [transactionId, setTransactionId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [mt5Login, setMt5Login] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!deposit) return;
    setDecision("approved");
    setAmount((deposit.amountMinor / 100).toFixed(2));
    setTransactionId("");
    setPaymentMethod(deposit.paymentMethod);
    setMt5Login(deposit.mt5Login);
    setNote("");
    setReason("");
  }, [deposit?.id]);

  const methods = useMemo(
    () => [...new Set([deposit?.paymentMethod ?? "", ...PAYMENT_METHODS])].filter(Boolean),
    [deposit?.paymentMethod],
  );
  const amountMinor = Math.round(Number(amount) * 100);
  const amountValid = Number.isFinite(amountMinor) && amountMinor > 0;
  const corrected = !!deposit && amountValid && amountMinor !== deposit.amountMinor;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!deposit) return;
    if (decision === "approved") {
      if (!amountValid) { toast.error("Enter the amount that arrived"); return; }
      if (!transactionId.trim()) { toast.error("Enter the transaction ID"); return; }
    } else if (reason.trim().length < 5) {
      toast.error("Add a short reason before rejecting");
      return;
    }
    try {
      const result = await decide.mutateAsync(decision === "approved"
        ? { decision, amountMinor, transactionId: transactionId.trim(), paymentMethod, mt5Login: mt5Login.trim(), note: note.trim() }
        : { decision, reason: reason.trim() });
      if (result.delivered) toast.success(result.message);
      else toast.warning(result.message);
      onClose();
    } catch (e) {
      // Refused by Tetra Commission (a transaction ID it already has): still
      // pending, and this dialog stays open to correct it.
      toast.error(e instanceof ApiError ? e.message : "Could not record the decision");
    }
  };

  return (
    <Dialog open={!!deposit} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review deposit</DialogTitle>
          <DialogDescription>From Tetra Commission — approving it records it there and credits the mentors&apos; commission.</DialogDescription>
        </DialogHeader>
        {deposit && <TetraDepositFacts deposit={deposit} />}
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Decision</Label>
            <Select value={decision} onValueChange={(v) => setDecision(v as "approved" | "rejected")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="approved">Approve</SelectItem>
                <SelectItem value="rejected">Reject</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {decision === "approved" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="tetra-amount">Amount that arrived (USD)</Label>
                  <Input id="tetra-amount" type="number" inputMode="decimal" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  {corrected && (
                    <p className="text-xs text-warning">
                      Requested <MoneyDisplay minor={deposit!.amountMinor} currency={deposit!.currency} /> — Tetra Commission records this amount instead.
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tetra-txn">Transaction ID</Label>
                  <Input id="tetra-txn" value={transactionId} onChange={(e) => setTransactionId(e.target.value)} maxLength={100} placeholder="As on the statement" />
                </div>
                <div className="space-y-1.5">
                  <Label>Payment method</Label>
                  <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                    <SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
                    <SelectContent>
                      {methods.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tetra-mt5">MT5 login</Label>
                  <Input id="tetra-mt5" value={mt5Login} onChange={(e) => setMt5Login(e.target.value)} maxLength={60} list="tetra-mt5-accounts" />
                  <datalist id="tetra-mt5-accounts">
                    {(deposit?.mt5Accounts ?? []).map((a) => <option key={a.login} value={a.login}>{a.platform}</option>)}
                  </datalist>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tetra-note">Note (optional)</Label>
                <Textarea id="tetra-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="tetra-reason">Reason (required)</Label>
              <Textarea id="tetra-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} placeholder="The mentor sees this in Tetra Commission" />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant={decision === "rejected" ? "destructive" : "primary"} loading={decide.isPending}>
              {decision === "approved" ? "Approve deposit" : "Reject deposit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
