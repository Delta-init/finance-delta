"use client";

import Link from "next/link";
import { ClipboardCheck, ArrowRight, UserCheck } from "lucide-react";
import { MoneyDisplay } from "@/components/ui/money";
import { Tooltip } from "@/components/ui/tooltip";
import { useExpenses } from "@/features/expenses/api";
import { useCan } from "@/lib/use-can";
import { useSession } from "next-auth/react";

/**
 * What is waiting on this approver.
 *
 * A queue rather than a second expenses screen: the list at /expenses already
 * filters by status, and what was missing was any reason to go and look. A
 * claim that nobody knows is waiting sits in "submitted" until the claimant
 * asks about it.
 *
 * Deliberately links through to each claim rather than offering approve here.
 * The receipt is on the claim, and a button that approves without it invites
 * approving without reading it.
 */
export function PendingApprovals() {
  const { can, canAny } = useCan();
  // Approving is one permission and listing is another. A role carrying only
  // expense:approve cannot read the queue it is meant to work through, so
  // fetching would just produce a refusal.
  const usable = can("expense:approve") && canAny("expense:read", "expense:read:own");
  const { data: session } = useSession();
  const myId = session?.user?.id;

  const { data, isLoading } = useExpenses(
    { status: "submitted", page: 1, pageSize: 5, sort: "createdAt", dir: "asc" },
    { enabled: usable },
  );

  if (!usable) return null;
  if (isLoading) return null;

  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  if (total === 0) return null;

  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5">
      <div className="flex items-center gap-2 border-b border-warning/20 px-5 py-3">
        <ClipboardCheck className="h-4 w-4 text-warning" />
        <h2 className="text-sm font-semibold">
          {total} claim{total === 1 ? "" : "s"} waiting on you
        </h2>
        <Link
          href="/expenses?status=submitted"
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          See all <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <ul className="divide-y divide-warning/20">
        {rows.map((e) => {
          // Approving your own claim is not blocked — in a small organization
          // the only approver may also be the only person claiming, and
          // blocking it would leave those claims stuck forever. It is marked
          // instead, so it is a decision somebody takes knowingly.
          const isMine = myId && String(e.submittedById) === String(myId);
          return (
            <li key={e.id}>
              <Link
                href={`/expenses/${e.id}`}
                className="flex items-center gap-3 px-5 py-3 hover:bg-warning/10"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{e.description}</p>
                  <p className="flex items-center gap-1.5 text-xs text-foreground-muted">
                    {e.submittedByName} · {new Date(e.expenseDate).toLocaleDateString()}
                    {isMine && (
                      <Tooltip label="You submitted this one. Approving your own claim is recorded against your name.">
                        <span className="inline-flex items-center gap-1 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                          <UserCheck className="h-2.5 w-2.5" /> yours
                        </span>
                      </Tooltip>
                    )}
                  </p>
                </div>
                <MoneyDisplay minor={e.totalMinor} currency={e.currency} />
              </Link>
            </li>
          );
        })}
      </ul>
      {total > rows.length && (
        <p className="px-5 py-2 text-xs text-foreground-muted">
          and {total - rows.length} more
        </p>
      )}
    </div>
  );
}
