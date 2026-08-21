"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";

// ── Supported currencies ──────────────────────────────────────────────────────

export const CURRENCIES = [
  { code: "AED", name: "UAE Dirham", symbol: "د.إ" },
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "EUR", name: "Euro", symbol: "€" },
  { code: "GBP", name: "British Pound", symbol: "£" },
  { code: "SAR", name: "Saudi Riyal", symbol: "﷼" },
  { code: "INR", name: "Indian Rupee", symbol: "₹" },
  { code: "QAR", name: "Qatari Riyal", symbol: "ر.ق" },
  { code: "PKR", name: "Pakistani Rupee", symbol: "₨" },
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];

const NON_BASE_LOWER = CURRENCIES.filter((c) => c.code !== "AED")
  .map((c) => c.code.toLowerCase())
  .join(",");

// ── Context ───────────────────────────────────────────────────────────────────

interface CurrencyContextValue {
  /** Currently selected display currency */
  currency: CurrencyCode;
  /** The organization's base currency from the session (e.g. "INR", "AED") */
  baseCurrency: string;
  setCurrency: (c: CurrencyCode) => void;
  /** Exchange rates relative to AED (AED = 1). {} while loading. */
  rates: Partial<Record<CurrencyCode, number>>;
  /** Date of the rate snapshot from the API */
  ratesDate: string;
  isLoadingRates: boolean;
  /** Convert AED minor units → selected currency minor units */
  convert: (minorAED: number) => number;
  /** Get the rate for any code (default 1 if unknown) */
  rateFor: (code: CurrencyCode) => number;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

const LS_KEY = "delta-display-currency";

// ── Provider ──────────────────────────────────────────────────────────────────

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<CurrencyCode>("AED");
  const { data: session } = useSession();
  const orgCurrency = (session?.user as Record<string, unknown> | undefined)?.baseCurrency as string | undefined;

  // Hydrate from localStorage after mount (avoid SSR mismatch)
  useEffect(() => {
    const saved = localStorage.getItem(LS_KEY) as CurrencyCode | null;
    if (saved && CURRENCIES.some((c) => c.code === saved)) {
      setCurrencyState(saved);
    }
  }, []);

  // Sync display currency when the org's base currency changes
  useEffect(() => {
    if (!orgCurrency) return;
    if (CURRENCIES.some((c) => c.code === orgCurrency)) {
      setCurrencyState(orgCurrency as CurrencyCode);
      localStorage.setItem(LS_KEY, orgCurrency);
    }
  }, [orgCurrency]);

  const setCurrency = (c: CurrencyCode) => {
    setCurrencyState(c);
    localStorage.setItem(LS_KEY, c);
  };

  const { data, isLoading } = useQuery<{
    date: string;
    rates: Partial<Record<CurrencyCode, number>>;
  }>({
    queryKey: ["fx-rates"],
    queryFn: () =>
      fetch(
        // fawaz CDN: free, no key, supports AED + all GCC/INR/PKR currencies
        `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/aed.min.json`,
      ).then((r) => {
        if (!r.ok) throw new Error("FX fetch failed");
        return r.json().then((j: { date: string; aed: Record<string, number> }) => ({
          date: j.date,
          rates: Object.fromEntries(
            Object.entries(j.aed)
              .filter(([k]) => NON_BASE_LOWER.split(",").includes(k))
              .map(([k, v]) => [k.toUpperCase(), v])
          ) as Partial<Record<CurrencyCode, number>>,
        }));
      }),
    staleTime: 60 * 60 * 1000,   // 1 hour — rates update daily
    gcTime: 4 * 60 * 60 * 1000,
    retry: 2,
    refetchOnWindowFocus: false,
  });

  const rates: Partial<Record<CurrencyCode, number>> = {
    AED: 1,
    ...(data?.rates ?? {}),
  };

  const rateFor = (code: CurrencyCode) => rates[code] ?? 1;

  // Stored amounts are in the organization's base currency (not always AED).
  // Convert from base → the selected display currency. When display == base
  // (the common case) this is a no-op, which prevents the earlier bug where
  // a non-AED org's amounts were multiplied by the FX rate a second time.
  const baseCurrency = (orgCurrency ?? "AED") as CurrencyCode;
  const convert = (minorInBase: number): number => {
    const baseRate = rateFor(baseCurrency);
    if (!baseRate) return minorInBase;
    return Math.round((minorInBase * rateFor(currency)) / baseRate);
  };

  return (
    <CurrencyContext.Provider
      value={{
        currency,
        baseCurrency,
        setCurrency,
        rates,
        ratesDate: data?.date ?? "",
        isLoadingRates: isLoading,
        convert,
        rateFor,
      }}
    >
      {children}
    </CurrencyContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useCurrency() {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error("useCurrency must be used inside CurrencyProvider");
  return ctx;
}
