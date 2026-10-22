"use client";

import { paymentMethodLabel } from "@delta/shared";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBankAccounts } from "./api";

/**
 * The Invoices and Expenses lists' "Paid by" and "Bank account" filters (the user, 2026-10-22: "filter for the
 * payment mode with bank filter"). "" is any; the account filter also offers "none" — paid into or from no account.
 */
export function PaymentMethodFilter({ methods, value, onChange, anyLabel = "Any" }: {
  methods: readonly string[];
  value: string;
  onChange: (v: string) => void;
  /** What "any" reads as — "All payment methods" where there is no label beside it. */
  anyLabel?: string;
}) {
  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
      <SelectTrigger className="w-[160px]" aria-label="Paid by"><SelectValue placeholder="Any" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{anyLabel}</SelectItem>
        {methods.map((m) => <SelectItem key={m} value={m}>{paymentMethodLabel(m)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function BankAccountFilter({ value, onChange, anyLabel = "Any" }: { value: string; onChange: (v: string) => void; anyLabel?: string }) {
  // Closed accounts too: older records were paid into them.
  const { data } = useBankAccounts({ pageSize: 100, sort: "name", dir: "asc" });
  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
      <SelectTrigger className="w-[180px]" aria-label="Bank account"><SelectValue placeholder="Any" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{anyLabel}</SelectItem>
        <SelectItem value="none">No account</SelectItem>
        {(data?.data ?? []).map((a) => (
          <SelectItem key={a.id} value={a.id}>{a.accountName}{a.isActive ? "" : " (closed)"}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Each method once, in the order first used — "Card + Tabby". */
export function methodsOf(methods: (string | undefined | null)[]): string {
  return [...new Set(methods.filter(Boolean).map((m) => paymentMethodLabel(m)))].join(" + ");
}

/** Each account once — "Delta Bank, Delta Petty". */
export function accountsOf(names: (string | undefined | null)[]): string {
  return [...new Set(names.map((n) => (n ?? "").trim()).filter(Boolean))].join(", ");
}
