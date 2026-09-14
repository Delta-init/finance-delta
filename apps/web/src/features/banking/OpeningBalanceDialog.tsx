"use client";

import { useEffect, useState } from "react";
import { formatMoney, toMinor, type BankAccount } from "@delta/shared";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useUpdateBankAccount } from "@/features/banking/api";

/**
 * Correcting the figure an account was opened with.
 *
 * It could only be set when the account was created, so a tin opened with the
 * wrong number stayed wrong for its whole life — and every balance under it,
 * since a cash book is the opening figure plus everything since.
 *
 * Which is also why this says what it will do before it does it: changing the
 * opening balance moves the closing balance by the same amount, and somebody
 * who has just counted the tin should see that coming rather than discover it
 * afterwards.
 */
export function OpeningBalanceDialog({
  account,
  open,
  onClose,
}: {
  account: BankAccount;
  open: boolean;
  onClose: () => void;
}) {
  const update = useUpdateBankAccount(account.id);
  const [amount, setAmount] = useState(String(account.openingBalanceMinor / 100));
  const [date, setDate] = useState(account.openingDate.slice(0, 10));

  // Reopening should show what the account says now, not what was typed and
  // abandoned last time.
  useEffect(() => {
    if (open) {
      setAmount(String(account.openingBalanceMinor / 100));
      setDate(account.openingDate.slice(0, 10));
    }
  }, [open, account.openingBalanceMinor, account.openingDate]);

  const nextOpening = toMinor(amount || "0");
  const delta = nextOpening - account.openingBalanceMinor;
  const nextClosing = account.currentBalanceMinor + delta;
  const changed = delta !== 0 || date !== account.openingDate.slice(0, 10);

  async function save() {
    try {
      await update.mutateAsync({ openingBalanceMinor: nextOpening, openingDate: date });
      toast.success("Opening balance updated");
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not update the opening balance");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Opening balance</DialogTitle>
          <DialogDescription>
            What {account.accountName} held before the first entry. Every balance in the book is
            measured from it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="opening-amount">Amount ({account.currency})</Label>
            <Input
              id="opening-amount"
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="opening-date">As of</Label>
            <Input
              id="opening-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          {/* Said before it happens, not discovered after. */}
          {delta !== 0 && (
            <div className="rounded-lg border border-border bg-surface-muted px-3 py-2.5 text-xs">
              <div className="flex justify-between">
                <span className="text-foreground-muted">Closing balance now</span>
                <span className="font-numeric">
                  {formatMoney(account.currentBalanceMinor, account.currency)}
                </span>
              </div>
              <div className="mt-1 flex justify-between font-medium">
                <span className="text-foreground-muted">After this change</span>
                <span className="font-numeric">{formatMoney(nextClosing, account.currency)}</span>
              </div>
              <p className="mt-2 text-foreground-muted">
                Every running balance in the book moves by{" "}
                {formatMoney(Math.abs(delta), account.currency)}
                {delta > 0 ? " upwards" : " downwards"}. Entries themselves are untouched.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={update.isPending} disabled={!changed} onClick={save}>
            Save opening balance
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
