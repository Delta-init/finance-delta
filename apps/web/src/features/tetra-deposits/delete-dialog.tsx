"use client";

import { useState } from "react";
import type { TetraDeposit } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MoneyDisplay } from "@/components/ui/money";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useDeleteTetraDeposit } from "./api";

/**
 * Deleting a deposit from the list (2026-10-28), with why. It is kept as "deleted" — the Deleted tab shows it, and it
 * can be restored. Not one waiting for a decision (reject it), nor one whose payment is still on an invoice: the API
 * says so.
 */
export const canDelete = (d: Pick<TetraDeposit, "status" | "delivery">) =>
  d.status !== "pending" && d.status !== "deleted" && !["sending", "queued"].includes(d.delivery?.state ?? "");

export function DeleteTetraDepositDialog({ deposit, onClose, onDeleted }: { deposit: TetraDeposit | null; onClose: () => void; onDeleted?: () => void }) {
  const del = useDeleteTetraDeposit();
  const [reason, setReason] = useState("");
  const close = () => { setReason(""); onClose(); };
  const submit = async () => {
    if (!deposit) return;
    if (reason.trim().length < 3) { toast.error("Say why it is deleted"); return; }
    try {
      await del.mutateAsync({ id: deposit.id, reason: reason.trim() });
      toast.success("Deleted — it is under the Deleted tab, and can be restored");
      close();
      onDeleted?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not delete it");
    }
  };
  return (
    <Dialog open={!!deposit} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this {deposit?.type === "BONUS" ? "bonus" : "deposit"}?</DialogTitle>
          <DialogDescription>
            {deposit && <>{deposit.student.name}{deposit.student.code ? ` · ${deposit.student.code}` : ""} · <MoneyDisplay minor={deposit.decision?.approvedAmountMinor ?? deposit.amountMinor} currency={deposit.currency} /> · {deposit.status}. </>}
            It leaves the list and every count, and is kept under the Deleted tab, where it can be restored. CS Portal is not told.
          </DialogDescription>
        </DialogHeader>
        <Textarea rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why — e.g. wrong amount, sent again" autoFocus />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={del.isPending}>{del.isPending ? "Deleting…" : "Delete"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
