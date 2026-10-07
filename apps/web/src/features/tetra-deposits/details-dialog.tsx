"use client";

import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/ui/money";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTetraDeposit } from "./api";
import { TetraDepositFacts, TetraTypeTag } from "./review-dialog";
import { TetraDepositStatusBadge, deliveryText, formatWhen } from "./status";

/**
 * Everything about one Tetra Commission deposit: what was asked, what was
 * decided and by whom, whether Tetra Commission has it, and each step of it
 * here. Read-only — deciding is done on the Approvals page, and the link to it
 * is offered while there is something to do there.
 */

const EVENT_LABELS: Record<string, string> = {
  received: "Received",
  approved: "Approved",
  rejected: "Rejected",
  delivered: "Tetra Commission updated",
  returned: "Back to pending",
  failed: "Not accepted",
  reopened: "Reopened",
  closed: "Closed",
};

export function TetraDepositDetailsDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const router = useRouter();
  const { data: deposit, isLoading } = useTetraDeposit(id);
  const decision = deposit?.decision;
  const delivery = deposit ? deliveryText(deposit) : "";
  const toDo = deposit && (deposit.status === "pending" || deposit.delivery?.state === "failed");

  return (
    <Dialog open={!!id} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {deposit ? deposit.student.name : "Deposit"}
            {deposit && <TetraDepositStatusBadge status={deposit.status} />}
            {deposit && <TetraTypeTag deposit={deposit} />}
          </DialogTitle>
          <DialogDescription>{deposit?.type === "BONUS" ? "A bonus request (course payment) from Tetra Commission." : deposit?.type === "COURSE_UPGRADE" ? "A course upgrade payment from Tetra Commission." : "A deposit request from Tetra Commission."}</DialogDescription>
        </DialogHeader>

        {isLoading || !deposit ? (
          <p className="py-6 text-sm text-foreground-muted">Loading…</p>
        ) : (
          <div className="space-y-4">
            <TetraDepositFacts deposit={deposit} />

            {decision && (
              <div className="rounded-lg border border-border p-3 text-sm">
                {deposit.status === "rejected" || (decision.reason && !decision.transactionId) ? (
                  <p className="font-medium">Rejected{decision.reason ? `: ${decision.reason}` : ""}</p>
                ) : (
                  <p className="font-medium">
                    Approved at <MoneyDisplay minor={decision.approvedAmountMinor ?? deposit.amountMinor} currency={deposit.currency} />
                    {decision.approvedAmountMinor !== undefined && decision.approvedAmountMinor !== deposit.amountMinor && (
                      <span className="ml-1 text-xs font-normal text-warning">(corrected from the requested amount)</span>
                    )}
                  </p>
                )}
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  {[
                    ["Transaction ID", decision.transactionId],
                    ["Payment method", decision.paymentMethod],
                    ["MT5 login", decision.mt5Login],
                    ["Note", decision.note],
                    ["Decided by", decision.decidedByName],
                    ["Decided", formatWhen(decision.decidedAt)],
                  ].filter(([, v]) => v).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-foreground-muted">{k}</dt>
                      <dd className="min-w-0 break-words font-medium">{v}</dd>
                    </div>
                  ))}
                </dl>
                {delivery && <p className="mt-2 text-xs text-foreground-muted">{delivery}</p>}
              </div>
            )}
            {!decision && delivery && <p className="text-xs text-foreground-muted">{delivery}</p>}

            {(deposit.events?.length ?? 0) > 0 && (
              <div>
                <p className="mb-2 text-sm font-semibold">History</p>
                <ol className="space-y-2 border-l border-border pl-4">
                  {deposit.events!.map((e, i) => (
                    <li key={i} className="text-xs">
                      <p className="font-medium">
                        {EVENT_LABELS[e.kind] ?? e.kind}
                        <span className="font-normal text-foreground-muted"> · {formatWhen(e.at)}{e.byName ? ` · ${e.byName}` : ""}</span>
                      </p>
                      {e.text && <p className="text-foreground-muted">{e.text}</p>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {toDo && (
            <Button type="button" variant="outline" onClick={() => router.push("/approvals")}>
              {deposit!.status === "pending" ? "Decide it on Approvals" : "Reopen it on Approvals"} <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
