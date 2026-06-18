"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";

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

const NON_BASE = CURRENCIES.filter((c) => c.code !== "AED")
  .map((c) => c.code)
  .join(",");

// ── Context ───────────────────────────────────────────────────────────────────

interface CurrencyContextValue {
  /** Currently selected display currency */
  currency: CurrencyCode;
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

  // Hydrate from localStorage after mount (avoid SSR mismatch)
  useEffect(() => {
    const saved = localStorage.getItem(LS_KEY) as CurrencyCode | null;
    if (saved && CURRENCIES.some((c) => c.code === saved)) {
      setCurrencyState(saved);
    }
  }, []);

  const setCurrency = (c: CurrencyCode) => {
    setCurrencyState(c);
    localStorage.setItem(LS_KEY, c);
  };

  const { data, isLoading } = useQuery<{
    base: string;
    date: string;
    rates: Record<string, number>;
  }>({
    queryKey: ["fx-rates"],
    queryFn: () =>
      fetch(
        `https://api.frankfurter.app/latest?base=AED&symbols=${NON_BASE}`,
      ).then((r) => {
        if (!r.ok) throw new Error("FX fetch failed");
        return r.json();
      }),
    staleTime: 60 * 60 * 1000,   // 1 hour — rates update daily
    gcTime: 4 * 60 * 60 * 1000,
    retry: 2,
    refetchOnWindowFocus: false,
  });

  const rates: Partial<Record<CurrencyCode, number>> = {
    AED: 1,
    ...(data?.rates as Partial<Record<CurrencyCode, number>>),
  };

  const rateFor = (code: CurrencyCode) => rates[code] ?? 1;

  const convert = (minorAED: number): number => {
    const rate = rateFor(currency);
    return Math.round(minorAED * rate);
  };

  return (
    <CurrencyContext.Provider
      value={{
        currency,
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
