"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Search, Bell, ChevronRight, ChevronDown, RefreshCw } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { CURRENCIES, useCurrency, type CurrencyCode } from "@/lib/currency-context";
import { cn } from "@/lib/utils";

interface SearchResult {
  invoices: { id: string; label: string; sub: string; href: string }[];
  quotations: { id: string; label: string; sub: string; href: string }[];
  customers: { id: string; label: string; sub: string; href: string }[];
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const debouncedQ = useDebounce(q, 250);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery<SearchResult>({
    queryKey: ["search", debouncedQ],
    queryFn: () => api.get<SearchResult>(`search?q=${encodeURIComponent(debouncedQ)}`),
    enabled: debouncedQ.length >= 2,
    staleTime: 10_000,
  });

  const hasResults = data && (data.invoices.length + data.quotations.length + data.customers.length) > 0;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const navigate = useCallback((href: string) => {
    setOpen(false);
    setQ("");
    router.push(href);
  }, [router]);

  const allResults = data ? [
    ...data.invoices.map((r) => ({ ...r, type: "Invoice" })),
    ...data.quotations.map((r) => ({ ...r, type: "Quotation" })),
    ...data.customers.map((r) => ({ ...r, type: "Customer" })),
  ] : [];

  return (
    <div ref={wrapRef} className="relative hidden sm:block">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => q.length >= 2 && setOpen(true)}
        placeholder="Search…"
        className="h-9 w-56 rounded-md border border-border bg-surface pl-8 pr-3 text-sm placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      {open && q.length >= 2 && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-xl border border-border bg-background shadow-lg">
          {!hasResults ? (
            <p className="px-4 py-3 text-sm text-foreground-muted">No results for "{q}"</p>
          ) : (
            <ul>
              {allResults.map((r) => (
                <li key={r.id + r.type}>
                  <button
                    onClick={() => navigate(r.href)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-surface-muted"
                  >
                    <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-foreground-muted border border-border">{r.type}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">{r.label}</span>
                      <span className="block truncate text-xs text-foreground-muted">{r.sub}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const SEGMENT_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  quotations: "Quotations",
  invoices: "Invoices",
  "credit-notes": "Credit Notes",
  payments: "Payments",
  "sales-orders": "Sales Orders",
  customers: "Customers",
  "purchase-orders": "Purchase Orders",
  bills: "Bills",
  "vendor-credits": "Vendor Credits",
  vendors: "Vendors",
  expenses: "Expenses",
  banking: "Banking",
  import: "Import",
  reconcile: "Reconcile",
  transaction: "Transaction",
  inventory: "Inventory",
  warehouses: "Warehouses",
  "price-lists": "Price Lists",
  valuation: "Valuation",
  adjust: "Adjust Stock",
  reports: "Reports",
  receivables: "Receivables",
  payables: "Payables",
  "profit-loss": "Profit & Loss",
  "balance-sheet": "Balance Sheet",
  "cash-flow": "Cash Flow",
  tax: "Tax Reports",
  other: "Other Reports",
  commissions: "Commissions",
  structures: "Structures",
  records: "Records",
  report: "Report",
  loans: "Loans & Credit",
  payroll: "Payroll",
  mapping: "Mapping",
  runs: "Runs",
  people: "People",
  departments: "Departments",
  settings: "Settings",
  admin: "Administration",
  users: "Users",
  roles: "Roles",
  tags: "Tags",
  new: "New",
  edit: "Edit",
};

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

function useBreadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);

  const crumbs: { label: string; href: string }[] = [];
  let path = "";
  for (const seg of segments) {
    path += `/${seg}`;
    let label: string;
    if (SEGMENT_LABELS[seg]) {
      label = SEGMENT_LABELS[seg];
    } else if (OBJECT_ID_RE.test(seg)) {
      label = "Detail";
    } else {
      label = seg.charAt(0).toUpperCase() + seg.slice(1);
    }
    crumbs.push({ label, href: path });
  }
  return crumbs;
}

function CurrencyPicker() {
  const { currency, setCurrency, rates, ratesDate, isLoadingRates } = useCurrency();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-sm font-medium transition-colors hover:bg-surface-muted",
          open && "border-primary/40 bg-surface-muted",
        )}
        aria-label="Switch display currency"
      >
        {isLoadingRates ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-foreground-subtle" />
        ) : null}
        <span className="text-foreground">{currency}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-foreground-subtle transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-background shadow-lg">
          {ratesDate && (
            <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs text-foreground-subtle">
              <RefreshCw className="h-3 w-3" />
              Rates as of {ratesDate} · ECB / Frankfurter
            </div>
          )}
          <ul className="py-1">
            {CURRENCIES.map((c) => {
              const rate = rates[c.code as CurrencyCode];
              const rateLabel =
                c.code === "AED"
                  ? "Base currency"
                  : rate != null
                    ? `1 AED = ${rate.toFixed(4)} ${c.code}`
                    : "—";
              return (
                <li key={c.code}>
                  <button
                    onClick={() => { setCurrency(c.code as CurrencyCode); setOpen(false); }}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-2.5 text-left text-sm transition-colors hover:bg-surface-muted",
                      currency === c.code && "bg-primary/5 text-primary",
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-8 font-mono text-xs font-semibold text-foreground">{c.code}</span>
                      <span className={currency === c.code ? "text-primary" : "text-foreground-muted"}>
                        {c.name}
                      </span>
                    </div>
                    <span className="text-xs text-foreground-subtle">{rateLabel}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export function SiteHeader() {
  const crumbs = useBreadcrumbs();

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background px-4 backdrop-blur-md">
      <SidebarTrigger />

      {/* Breadcrumbs */}
      {crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
          {crumbs.map((crumb, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <span key={crumb.href} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-foreground-subtle" />}
                {isLast ? (
                  <span className="font-semibold text-foreground">{crumb.label}</span>
                ) : (
                  <Link
                    href={crumb.href}
                    className="text-foreground-muted transition-colors hover:text-foreground"
                  >
                    {crumb.label}
                  </Link>
                )}
              </span>
            );
          })}
        </nav>
      )}

      <div className="ml-auto flex items-center gap-2">
        <GlobalSearch />
        <CurrencyPicker />
        <button
          aria-label="Notifications"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground"
        >
          <Bell className="h-[18px] w-[18px]" />
          <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-primary" />
        </button>
      </div>
    </header>
  );
}
