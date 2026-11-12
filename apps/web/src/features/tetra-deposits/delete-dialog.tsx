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
import { typedApproved } from "./review-dialog";

/**
 * Deleting a deposit from the list (2026-10-28), with why — by a Super Admin, an Administrator or a Manager
 * (tetra_deposit:delete, 2026-11-12). It is kept as "deleted" under the Deleted tab. A pending or rejected deposit or
 * bonus is deleted in CS Portal too, and then cannot be restored here. Not a course upgrade or balance payment waiting
 * for a decision (reject it), nor one whose payment is still on an invoice: the API says so.
 */
const CS_PORTAL_FUNDING = ["DEPOSIT", "BONUS"];
export const deletesInCsPortal = (d: Pick<TetraDeposit, "status" | "type">) =>
  CS_PORTAL_FUNDING.includes(String(d.type ?? "DEPOSIT")) && (d.status === "pending" || d.status === "rejected");
export const canDelete = (d: Pick<TetraDeposit, "status" | "delivery" | "type">) =>
  (d.status !== "pending" || deletesInCsPortal(d)) && d.status !== "deleted" && !["sending", "queued"].includes(d.delivery?.state ?? "");

export function DeleteTetraDepositDialog({ deposit, onClose, onDeleted }: { deposit: TetraDeposit | null; onClose: () => void; onDeleted?: () => void }) {
  const del = useDeleteTetraDeposit();
  const [reason, setReason] = useState("");
  const close = () => { setReason(""); onClose(); };
  const submit = async () => {
    if (!deposit) return;
    if (reason.trim().length < 3) { toast.error("Say why it is deleted"); return; }
    try {
      const done = await del.mutateAsync({ id: deposit.id, reason: reason.trim() });
      const c = (done as TetraDeposit | undefined)?.deleted?.csPortal;
      toast.success(!c ? "Deleted — it is under the Deleted tab, and can be restored"
        : c.state === "done" ? "Deleted — and deleted in CS Portal too"
        : c.state === "kept" ? `Deleted here — CS Portal kept it${c.message ? `: ${c.message}` : ""}`
        : "Deleted — CS Portal deletes it too as soon as it can be reached");
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
            {deposit && <>{deposit.student.name}{deposit.student.code ? ` · ${deposit.student.code}` : ""} · <MoneyDisplay minor={typedApproved(deposit, deposit.decision?.approvedAmountMinor).minor} currency={typedApproved(deposit, deposit.decision?.approvedAmountMinor).currency} /> · {deposit.status}. </>}
            {deposit && deletesInCsPortal(deposit)
              ? "It leaves the list and every count, and is kept under the Deleted tab. CS Portal deletes the request too, so it is raised again there if it is needed."
              : "It leaves the list and every count, and is kept under the Deleted tab, where it can be restored. CS Portal is not told."}
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
