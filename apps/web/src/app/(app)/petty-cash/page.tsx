"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Wallet } from "lucide-react";
import { formatMoney, type BankAccount } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MoneyDisplay } from "@/components/ui/money";
import { useCan } from "@/lib/use-can";
import { useBankAccounts } from "@/features/banking/api";
import { CashBook } from "@/features/banking/CashBook";
import { CashCounts } from "@/features/banking/CashCounts";

/**
 * The tin, reachable without knowing it lives inside Banking.
 *
 * Petty cash is a bank account underneath, and finding it meant knowing that —
 * open Banking, know which of the accounts is the tin, open it. The people who
 * keep a tin are not the people who think of it as a bank account.
 *
 * One tin opens straight onto its cash book, because that is the whole page for
 * somebody with one. Several list first; none says so and offers to make one.
 */
export default function PettyCashPage() {
  const router = useRouter();
  const { can } = useCan();
  const { data, isLoading } = useBankAccounts({
    accountType: "petty_cash",
    isActive: "true",
    pageSize: 50,
    sort: "name",
    dir: "asc",
  });

  if (isLoading) {
    return <div className="p-6 text-sm text-foreground-muted">Loading…</div>;
  }

  const tins = data?.data ?? [];

  if (tins.length === 0) {
    return (
      <div className="space-y-6 p-4 md:p-6">
        <PageHeader icon={Wallet} title="Petty cash" description="The cash you keep on hand." />
        <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-surface p-10 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-muted">
            <Wallet className="h-6 w-6 text-foreground-subtle" />
          </div>
          <div>
            <p className="text-sm font-medium">No tin set up yet</p>
            <p className="mt-1 text-sm text-foreground-muted">
              Add one with the cash that is in it today as the opening balance, and the date you
              counted it.
            </p>
          </div>
          {can("banking:write") && (
            <Link href="/banking/new?type=petty_cash">
              <Button size="sm"><Plus className="h-4 w-4" /> Set up petty cash</Button>
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (tins.length === 1) {
    return <SingleTin account={tins[0]!} />;
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader icon={Wallet} title="Petty cash" description="The cash you keep on hand." />
      <ul className="grid gap-3 sm:grid-cols-2">
        {tins.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => router.push(`/banking/${a.id}`)}
              className="w-full rounded-lg border border-border bg-surface p-4 text-left transition-colors hover:border-primary"
            >
              <div className="flex items-center gap-2">
                <Wallet className="h-4 w-4 text-foreground-muted" />
                <span className="text-sm font-medium">{a.accountName}</span>
                <Badge tone="neutral" className="ml-auto">{a.currency}</Badge>
              </div>
              <MoneyDisplay
                minor={a.currentBalanceMinor}
                currency={a.currency}
                className={`mt-2 block text-2xl font-bold ${
                  a.currentBalanceMinor < 0 ? "text-danger" : "text-foreground"
                }`}
              />
              <p className="mt-1 text-xs text-foreground-subtle">
                {a.lastReconciledAt
                  ? `Last counted ${a.lastReconciledAt.slice(0, 10)}`
                  : "Never counted"}
              </p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SingleTin({ account }: { account: BankAccount }) {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          icon={Wallet}
          title={account.accountName}
          description={`Petty cash · ${account.currency}${
            account.lastReconciledAt ? ` · last counted ${account.lastReconciledAt.slice(0, 10)}` : ""
          }`}
        />
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-foreground-muted">In the tin</p>
          <p
            className={`font-numeric text-2xl font-bold ${
              account.currentBalanceMinor < 0 ? "text-danger" : "text-foreground"
            }`}
          >
            {formatMoney(account.currentBalanceMinor, account.currency)}
          </p>
        </div>
      </div>

      <CashBook account={account} />

      <CashCounts account={account} />
    </div>
  );
}
