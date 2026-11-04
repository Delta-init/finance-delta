"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, WalletCards } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useWallet, walletThisMonth } from "@/features/wallet/api";
import { WalletView } from "@/features/wallet/wallet-view";

/**
 * My Wallet (2026-11-04) — the same wallet as in HRMS: salary a day at a time, what came off and why, your
 * commission, and what finance has paid you. Your own only; a month at a time, back as far as you've been employed.
 */

const shift = (month: string, by: number) => {
  const [y = 1970, m = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
};
const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

export default function WalletPage() {
  const [month, setMonth] = useState(walletThisMonth);
  const { data: w, isLoading, isFetching, error } = useWallet(month);
  const first = w?.firstMonth ?? shift(walletThisMonth(), -12);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader
        icon={WalletCards}
        title="My Wallet"
        description="Your pay a day at a time — what came off and why, your commission, and what finance has paid you"
        action={
          <div className="flex items-center gap-2">
            {isFetching && !isLoading && <Loader2 className="h-4 w-4 animate-spin text-foreground-muted" />}
            <div className="flex items-center rounded-lg border border-border">
              <Button variant="ghost" size="icon" aria-label="Previous month" disabled={month <= first} onClick={() => setMonth((m) => shift(m, -1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-[8.5rem] text-center text-sm font-medium">{monthLabel(month)}</span>
              <Button variant="ghost" size="icon" aria-label="Next month" disabled={month >= walletThisMonth()} onClick={() => setMonth((m) => shift(m, 1))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        }
      />

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-foreground-muted" /></div>
      ) : error || !w ? (
        <Card className="p-6 text-center text-sm text-foreground-muted">{(error as Error | null)?.message ?? "Your wallet couldn't be loaded. Try again in a moment."}</Card>
      ) : (
        <WalletView w={w} />
      )}
    </div>
  );
}
