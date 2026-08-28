"use client";

import { useMemo, useState } from "react";
import { Banknote, AlertTriangle, PauseCircle } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyDisplay } from "@/components/ui/money";
import { useBankAccounts } from "@/features/banking/api";
import type { PayPayload } from "./api";
import type { RunLine } from "./types";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Paying the run.
 *
 * The total is computed from the lines actually being paid rather than from the
 * run's headline figure, because held people are excluded and a part-paid
 * person only takes their remainder. Showing the run total here would promise a
 * transfer of a different size from the one about to happen.
 */
export function PayDialog({
  open, onOpenChange, lines, selectedIds, currency, onSubmit, pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: RunLine[];
  /** Empty means everybody still owed. */
  selectedIds: string[];
  currency: string;
  onSubmit: (input: PayPayload) => void;
  pending: boolean;
}) {
  const accounts = useBankAccounts({ page: 1, pageSize: 100 });
  const [bankAccountId, setBankAccountId] = useState("");
  const [method, setMethod] = useState<PayPayload["method"]>("bank_transfer");
  const [paidOn, setPaidOn] = useState(today());
  const [reference, setReference] = useState("");

  const { payable, held, total } = useMemo(() => {
    const wanted = selectedIds.length ? new Set(selectedIds) : null;
    const scope = lines.filter((l) => !wanted || wanted.has(l.id));
    const payable = scope.filter(
      (l) => l.status !== "on_hold" && l.status !== "paid" && l.payableMinor > l.amountPaidMinor,
    );
    return {
      payable,
      held: scope.filter((l) => l.status === "on_hold"),
      total: payable.reduce((a, l) => a + (l.payableMinor - l.amountPaidMinor), 0),
    };
  }, [lines, selectedIds]);

  const eligible = (accounts.data?.data ?? []).filter((a) => a.currency === currency && a.isActive);
  const ready = Boolean(bankAccountId) && payable.length > 0 && Boolean(paidOn);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pay {payable.length} {payable.length === 1 ? "person" : "people"}</DialogTitle>
          <DialogDescription>
            This records the transfer against a bank account and tells HRMS, which marks the payslips
            paid. It does not move money by itself — make the transfer in your bank first.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-foreground-muted">Total to transfer</span>
              <span className="text-lg font-semibold"><MoneyDisplay minor={total} currency={currency} /></span>
            </div>
          </div>

          {held.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 p-2.5 text-xs">
              <PauseCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                {held.length} {held.length === 1 ? "person is" : "people are"} held for missing bank details and
                will not be paid or marked paid. They stay outstanding on this run.
              </span>
            </p>
          )}

          <div className="space-y-1.5">
            <Label>Paid from</Label>
            <Select value={bankAccountId} onValueChange={setBankAccountId}>
              <SelectTrigger>
                <SelectValue placeholder={eligible.length ? "Pick an account" : `No active ${currency} account`} />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.accountName} · <MoneyDisplay minor={a.currentBalanceMinor} currency={a.currency} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {accounts.data && eligible.length === 0 && (
              <p className="text-xs text-danger">
                This run is in {currency}. Paying from another currency needs an exchange rate and a
                decision about who bears the difference, so it is not offered here.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Method</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as PayPayload["method"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank_transfer">Bank transfer</SelectItem>
                  <SelectItem value="cheque">Cheque</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="online">Online</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="paid-on">Paid on</Label>
              <Input id="paid-on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-ref">Reference (optional)</Label>
            <Input
              id="pay-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="WPS batch or transfer id"
              maxLength={120}
            />
          </div>

          <p className="flex items-start gap-2 text-xs text-foreground-muted">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Recording a payment cannot be undone from this screen. If a transfer bounces, reverse it
            so the payslips go back to issued.
          </p>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            loading={pending}
            disabled={!ready}
            onClick={() =>
              onSubmit({
                lineIds: selectedIds.length ? selectedIds : undefined,
                bankAccountId,
                method,
                paidOn,
                reference: reference.trim() || undefined,
              })
            }
          >
            <Banknote className="h-4 w-4" />Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
