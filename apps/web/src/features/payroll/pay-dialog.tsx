"use client";

import { useEffect, useMemo, useState } from "react";
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
import { cn } from "@/lib/utils";
import type { PayPayload } from "./api";
import type { RunLine } from "./types";

const today = () => new Date().toISOString().slice(0, 10);

/** A line's currency, or the run's for a line imported before lines carried one. */
const currencyOf = (l: RunLine, runCurrency: string) => (l.currency || runCurrency).trim().toUpperCase();

/**
 * Paying the run.
 *
 * The total is computed from the lines actually being paid rather than from the
 * run's headline figure, because held people are excluded and a part-paid
 * person only takes their remainder. Showing the run total here would promise a
 * transfer of a different size from the one about to happen.
 *
 * One currency at a time (2026-10-30). A bank account pays out in one currency,
 * and a month can hold salaries in dirhams and in rupees, so a payment covers
 * the people paid in the chosen currency, from an account in it. This used to
 * add every salary into one figure and offer only the run's currency's
 * accounts, which took the rupee salaries out of a dirham account as dirhams.
 */
export function PayDialog({
  open, onOpenChange, lines, selectedIds, runCurrency, onSubmit, pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: RunLine[];
  /** Empty means everybody still owed. */
  selectedIds: string[];
  /** What a line without a currency of its own is paid in. */
  runCurrency: string;
  onSubmit: (input: PayPayload) => void;
  pending: boolean;
}) {
  const accounts = useBankAccounts({ page: 1, pageSize: 100 });
  const [bankAccountId, setBankAccountId] = useState("");
  const [method, setMethod] = useState<PayPayload["method"]>("bank_transfer");
  const [paidOn, setPaidOn] = useState(today());
  const [reference, setReference] = useState("");
  const [chosen, setChosen] = useState("");

  /** The people in scope, per currency: the run's currency first, then by how many people. */
  const groups = useMemo(() => {
    const wanted = selectedIds.length ? new Set(selectedIds) : null;
    const scope = lines.filter((l) => !wanted || wanted.has(l.id));
    const by = new Map<string, { currency: string; payable: RunLine[]; held: RunLine[] }>();
    for (const l of scope) {
      const currency = currencyOf(l, runCurrency);
      const g = by.get(currency) ?? { currency, payable: [], held: [] };
      if (l.status === "on_hold") g.held.push(l);
      else if (l.status !== "paid" && l.payableMinor > l.amountPaidMinor) g.payable.push(l);
      by.set(currency, g);
    }
    const lead = runCurrency.trim().toUpperCase();
    return [...by.values()]
      .filter((g) => g.payable.length > 0 || g.held.length > 0)
      .sort(
        (a, b) =>
          (a.currency === lead ? 0 : 1) - (b.currency === lead ? 0 : 1) ||
          b.payable.length - a.payable.length ||
          a.currency.localeCompare(b.currency),
      );
  }, [lines, selectedIds, runCurrency]);

  // The first currency anybody can be paid in, until somebody picks another;
  // the account is cleared when the currency changes, since it no longer fits.
  const firstPayable = groups.find((g) => g.payable.length > 0)?.currency ?? groups[0]?.currency ?? "";
  const currency = groups.some((g) => g.currency === chosen) ? chosen : firstPayable;
  useEffect(() => { setBankAccountId(""); }, [currency]);
  useEffect(() => { if (!open) setChosen(""); }, [open]);

  const group = groups.find((g) => g.currency === currency);
  const payable = group?.payable ?? [];
  const held = group?.held ?? [];
  const total = payable.reduce((a, l) => a + (l.payableMinor - l.amountPaidMinor), 0);

  const eligible = (accounts.data?.data ?? []).filter(
    (a) => a.currency.trim().toUpperCase() === currency && a.isActive,
  );
  const ready = Boolean(bankAccountId) && payable.length > 0 && Boolean(paidOn);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Pay {payable.length} {payable.length === 1 ? "person" : "people"}{currency ? ` in ${currency}` : ""}
          </DialogTitle>
          <DialogDescription>
            This records the transfer against a bank account and tells HRMS, which marks the payslips
            paid. It does not move money by itself — make the transfer in your bank first.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {groups.length > 1 && (
            <div className="space-y-1.5">
              <Label>Paying the people paid in</Label>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Currency">
                {groups.map((g) => (
                  <button
                    key={g.currency}
                    type="button"
                    role="radio"
                    aria-checked={g.currency === currency}
                    onClick={() => setChosen(g.currency)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left text-sm",
                      g.currency === currency ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                    )}
                  >
                    <span className="font-mono font-semibold">{g.currency}</span>
                    <span className="block text-xs text-foreground-muted">
                      {g.payable.length} {g.payable.length === 1 ? "person" : "people"} to pay
                      {g.held.length > 0 ? ` · ${g.held.length} held` : ""}
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-foreground-muted">
                A bank account pays out in one currency, so each currency is a payment of its own. The
                others stay outstanding until they are paid.
              </p>
            </div>
          )}

          <div className="rounded-lg border border-border bg-surface-muted p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-foreground-muted">Total to transfer</span>
              <span className="text-right text-lg font-semibold">
                <MoneyDisplay minor={total} currency={currency || runCurrency} showConverted />
              </span>
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
                There is no active {currency} bank account. Add one under Banking to pay the people paid in{" "}
                {currency}. Paying them from an account in another currency would need an exchange rate and a
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
                // Exactly the people of the chosen currency: never "everybody",
                // which a run in two currencies cannot pay from one account.
                lineIds: payable.map((l) => l.id),
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
