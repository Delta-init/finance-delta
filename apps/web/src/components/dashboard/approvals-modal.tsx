"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MoneyDisplay } from "@/components/ui/money";
import { useApprovalSummary } from "@/features/approvals/api";
import { useCan } from "@/lib/use-can";
import { readPopupState, recordShown, shouldShowPopup, writePopupState } from "@/lib/approvals-popup";

/**
 * "Waiting for your approval", put in front of an approver when they arrive.
 *
 * The panels further down the dashboard say the same thing, but only to
 * somebody who scrolls to them. This is shown after signing in and at most
 * twice a day — signing in again starts over (lib/approvals-popup.ts) — so it
 * is hard to miss without becoming something to click away every visit.
 *
 * Lists and links; nothing is approved from here. The receipt, the figures,
 * what a department has left: those are on the page each item links to, and a
 * decision should be made looking at them.
 */
export function ApprovalsModal() {
  const router = useRouter();
  const { data: session } = useSession();
  const { can } = useCan();
  const approver = can("invoice:write") || can("budget:approve") || can("tetra_deposit:approve") || can("expense:approve") || can("bill:approve") || can("payroll:approve");
  const { data } = useApprovalSummary(approver);
  const [open, setOpen] = useState(false);

  const userId = session?.user?.id;
  const signedInAt = session?.user?.signedInAt ?? 0;

  useEffect(() => {
    if (!data || !userId || data.total === 0) return;
    const key = `finance:approvals-popup:${userId}`;
    const prev = readPopupState(key);
    const now = new Date();
    if (!shouldShowPopup(prev, now, signedInAt)) return;
    writePopupState(key, recordShown(prev, now, signedInAt));
    setOpen(true);
  }, [data, userId, signedInAt]);

  if (!data) return null;
  const groups = data.groups.filter((g) => g.count > 0);
  const close = () => setOpen(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-warning" /> Waiting for your approval
          </DialogTitle>
          <DialogDescription>
            {data.total === 1 ? "One thing needs a decision from you." : `${data.total} things need a decision from you.`}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-1">
          {groups.map((g) => (
            <div key={g.type}>
              <div className="mb-1.5 flex items-center gap-2">
                <p className="text-sm font-semibold">{g.label}</p>
                <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">{g.count}</span>
                <Link href={g.href} onClick={close} className="ml-auto text-xs font-medium text-primary hover:underline">
                  Open
                </Link>
              </div>
              <ul className="divide-y divide-border rounded-md border border-border">
                {g.items.slice(0, 3).map((item) => (
                  <li key={item.id}>
                    <Link href={item.href} onClick={close} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-muted/60">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{item.title}</p>
                        <p className="truncate text-xs text-foreground-muted">{item.subtitle}</p>
                      </div>
                      {item.amountMinor !== undefined && (
                        <div className="shrink-0 text-right">
                          <MoneyDisplay minor={item.amountMinor} currency={item.currency ?? "AED"} className="text-sm" />
                          {/* An enrolment: the amount is what was collected; its fee under it. */}
                          {item.feeMinor !== undefined && (
                            <p className="text-xs text-foreground-muted">
                              of <MoneyDisplay minor={item.feeMinor} currency={item.currency ?? "AED"} /> fee
                            </p>
                          )}
                        </div>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
              {g.count > 3 && <p className="mt-1 text-xs text-foreground-muted">and {g.count - 3} more</p>}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>Later</Button>
          <Button type="button" onClick={() => { close(); router.push("/approvals"); }}>Open approvals</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
