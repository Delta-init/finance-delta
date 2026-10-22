"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight, Trash2 } from "lucide-react";
import { formatMoney, toMinor, type BankAccount, type BankTransaction } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useBankAccounts, useCreateTransfer, useDeleteTransfer, useUpdateTransfer } from "@/features/banking/api";
import { LateReasonField, useLateDate } from "@/features/late-entries/LateReason";

const today = () => new Date().toISOString().slice(0, 10);
const shown = (minor: number) => (minor / 100).toFixed(2);

/**
 * Moving money between two of the organization's own accounts (the user, 2026-10-22: "a new item in petty cash, an
 * internal transfer"): a tin topped up from the bank, its cash banked, one bank to another. Opened from an account,
 * so it asks which way — in to this account, or out of it — and the other account. Between currencies it asks both
 * figures. Opened on a line of a transfer, it corrects or deletes the whole transfer: both sides move together.
 */
export function TransferDialog({
  account,
  line,
  open,
  onClose,
}: {
  /** The account it is opened from. */
  account: BankAccount;
  /** A line of the transfer being corrected, or nothing when making one. */
  line?: BankTransaction | null;
  open: boolean;
  onClose: () => void;
}) {
  const editing = Boolean(line?.transfer);
  const { data: list } = useBankAccounts({ isActive: "true", pageSize: 100 });
  const others = (list?.data ?? []).filter((a) => a.id !== account.id);
  const create = useCreateTransfer();
  const update = useUpdateTransfer();
  const remove = useDeleteTransfer();

  // In to this account (a tin topped up) or out of it (cash banked, or one bank paying another).
  const [direction, setDirection] = useState<"in" | "out">(account.accountType === "petty_cash" ? "in" : "out");
  const [otherId, setOtherId] = useState("");
  const [date, setDate] = useState(today);
  const [sent, setSent] = useState("");
  const [received, setReceived] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lateReason, setLateReason] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    setLateReason("");
    if (line?.transfer) {
      const t = line.transfer;
      setDirection(t.direction);
      setOtherId(t.otherAccountId);
      setDate(line.date.slice(0, 10));
      // What left the "out" side, and what arrived on the "in" side.
      setSent(shown(t.direction === "out" ? Math.abs(line.amountMinor) : t.otherAmountMinor));
      setReceived(shown(t.direction === "out" ? t.otherAmountMinor : line.amountMinor));
      setReference(line.reference ?? "");
      setNotes(line.notes ?? "");
    } else {
      setDirection(account.accountType === "petty_cash" ? "in" : "out");
      setOtherId("");
      setDate(today());
      setSent("");
      setReceived("");
      setReference("");
      setNotes("");
    }
  }, [open, line, account.accountType]);

  const other = others.find((a) => a.id === otherId)
    ?? (line?.transfer ? { id: line.transfer.otherAccountId, accountName: line.transfer.otherAccountName, currency: line.transfer.otherCurrency } as Pick<BankAccount, "id" | "accountName" | "currency"> : undefined);
  const from = direction === "out" ? account : other;
  const to = direction === "out" ? other : account;
  const twoCurrencies = !!from && !!to && from.currency !== to.currency;
  const sentMinor = toMinor(sent || "0");
  const receivedMinor = twoCurrencies ? toMinor(received || "0") : sentMinor;
  const lateDate = useLateDate(date, line?.date);
  const canSave = !!other && sentMinor > 0 && receivedMinor > 0 && !!date && (!lateDate.late || lateReason.trim().length > 0);

  async function save() {
    if (!canSave || !from || !to) return;
    const common = {
      date, amountMinor: sentMinor, ...(twoCurrencies ? { receivedMinor } : {}),
      reference: reference.trim(), notes: notes.trim(), ...(lateDate.late ? { lateReason: lateReason.trim() } : {}),
    };
    try {
      if (editing) {
        await update.mutateAsync({ id: line!.transfer!.id, input: common });
        toast.success("Transfer updated");
      } else {
        await create.mutateAsync({ fromAccountId: from.id, toAccountId: to.id, ...common });
        toast.success(`${formatMoney(sentMinor, from.currency)} moved from ${from.accountName} to ${to.accountName}`);
      }
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save the transfer");
    }
  }

  async function del() {
    try {
      await remove.mutateAsync(line!.transfer!.id);
      toast.success("Transfer deleted — both sides");
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not delete it");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 text-foreground-muted" />
            {editing ? "Edit transfer" : "Transfer"}
          </DialogTitle>
          <DialogDescription>
            Between two of your own accounts — not income or an expense. One account goes down, the other up, on the same day.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {editing ? (
            <p className="rounded-md bg-surface-muted px-3 py-2 text-sm">
              {from?.accountName} → {to?.accountName}
            </p>
          ) : (
            <>
              <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-sm" role="tablist" aria-label="Which way">
                {(["in", "out"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="tab"
                    aria-selected={direction === d}
                    onClick={() => setDirection(d)}
                    className={`rounded-md px-3 py-1.5 font-medium ${direction === d ? "bg-primary text-primary-foreground" : "text-foreground-muted hover:text-foreground"}`}
                  >
                    {d === "in" ? `Into ${account.accountName}` : `Out of ${account.accountName}`}
                  </button>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label>{direction === "in" ? "From" : "To"}</Label>
                <Select value={otherId} onValueChange={setOtherId}>
                  <SelectTrigger><SelectValue placeholder="Choose the account" /></SelectTrigger>
                  <SelectContent>
                    {others.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.accountName} · {formatMoney(a.currentBalanceMinor, a.currency)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          <div className={`grid gap-4 ${twoCurrencies ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
            <div className="space-y-1.5">
              <Label htmlFor="tr-date">Date</Label>
              <Input id="tr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-sent">{twoCurrencies ? `Sent (${from?.currency})` : `Amount${from ? ` (${from.currency})` : ""}`}</Label>
              <Input id="tr-sent" type="number" step="0.01" min="0" value={sent} placeholder="0.00" onChange={(e) => setSent(e.target.value)} />
            </div>
            {twoCurrencies && (
              <div className="space-y-1.5">
                <Label htmlFor="tr-received">Received ({to?.currency})</Label>
                <Input id="tr-received" type="number" step="0.01" min="0" value={received} placeholder="0.00" onChange={(e) => setReceived(e.target.value)} />
              </div>
            )}
          </div>

          <LateReasonField late={lateDate.late} days={lateDate.days} value={lateReason} onChange={setLateReason} what="transfer" />

          {!editing && from && to && sentMinor > 0 && receivedMinor > 0 && (
            <p className="text-xs text-foreground-muted">
              {from.accountName} goes down by <span className="font-numeric font-medium text-foreground">{formatMoney(sentMinor, from.currency)}</span>;{" "}
              {to.accountName} goes up by <span className="font-numeric font-medium text-foreground">{formatMoney(receivedMinor, to.currency)}</span>.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tr-ref">Reference</Label>
              <Input id="tr-ref" value={reference} maxLength={100} placeholder="Optional — slip or cheque no." onChange={(e) => setReference(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-notes">Note</Label>
              <Input id="tr-notes" value={notes} maxLength={1000} placeholder="Optional" onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          {editing && confirmDelete && (
            <p className="rounded-md border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger">
              Both sides go: {line?.transfer?.direction === "out" ? `${account.accountName} gets it back and ${line?.transfer?.otherAccountName} loses it` : `${account.accountName} loses it and ${line?.transfer?.otherAccountName} gets it back`}. Press Delete again to confirm.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {editing ? (
            <Button variant="ghost" className="text-danger" loading={remove.isPending} onClick={() => (confirmDelete ? void del() : setConfirmDelete(true))}>
              <Trash2 className="h-4 w-4" /> {confirmDelete ? "Delete both sides" : "Delete transfer"}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void save()} disabled={!canSave} loading={create.isPending || update.isPending}>
              {editing ? "Save" : "Transfer"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
