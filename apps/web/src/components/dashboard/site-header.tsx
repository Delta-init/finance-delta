"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Search, Bell, ChevronRight, ChevronDown, RefreshCw, Columns2, X } from "lucide-react";
import { useSplit } from "@/components/split-view/side-page";
import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { CURRENCIES, useCurrency, type CurrencyCode } from "@/lib/currency-context";
import { cn } from "@/lib/utils";
import { BackButton } from "@/components/dashboard/back-button";

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

/** The search box — in the bar from sm up; on a phone (`phone`) a full-width row under the bar, opened by its icon. */
function GlobalSearch({ phone = false, onDone }: { phone?: boolean; onDone?: () => void } = {}) {
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

  // Quotations are out of finance's menus (the user, 2026-10-22), so the search does not offer them either.
  const hasResults = data && (data.invoices.length + data.customers.length) > 0;

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
    onDone?.();
    router.push(href);
  }, [router, onDone]);

  const allResults = data ? [
    ...data.invoices.map((r) => ({ ...r, type: "Invoice" })),
    ...data.customers.map((r) => ({ ...r, type: "Customer" })),
  ] : [];

  return (
    <div ref={wrapRef} className={phone ? "relative w-full" : "relative hidden sm:block"}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => q.length >= 2 && setOpen(true)}
        placeholder="Search invoices, clients…"
        autoFocus={phone}
        className={cn(
          "h-9 rounded-md border border-border bg-surface pl-8 pr-3 text-sm placeholder:text-foreground-subtle focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          phone ? "w-full text-base" : "w-56",
        )}
      />
      {open && q.length >= 2 && (
        <div className={cn("absolute top-full z-50 mt-1 overflow-hidden rounded-xl border border-border bg-background shadow-lg", phone ? "inset-x-0" : "right-0 w-80")}>
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
  crm: "CRM commission",
  report: "Report",
  loans: "Loans & Credit",
  "tetra-deposits": "Tetra Deposits",
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

// A record's id — or a salesperson page's `login-<id>` (someone on invoices who is not on the payroll).
const OBJECT_ID_RE = /^(login-)?[0-9a-f]{24}$/i;

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

/** The split screen (2026-11-17): open a page beside this one — or close the one beside. Cmd/Ctrl + \\ does the same. */
function SplitButton() {
  const { side, closeSide, setPickerOpen } = useSplit();
  return (
    <button
      type="button"
      onClick={() => (side ? closeSide() : setPickerOpen(true))}
      title={side ? "Close the page beside (Cmd/Ctrl + \\)" : "Open a page beside this one (Cmd/Ctrl + \\)"}
      aria-pressed={!!side}
      className={cn(
        "hidden h-9 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition-colors md:inline-flex",
        side ? "border-primary/40 bg-primary-50 text-primary" : "border-border text-foreground-muted hover:bg-surface-muted hover:text-foreground",
      )}
    >
      <Columns2 className="h-4 w-4" /> {side ? "Close split" : "Split"}
    </button>
  );
}

export function SiteHeader() {
  const crumbs = useBreadcrumbs();
  // Where Back goes when there is no finance page behind this one: up a level (2026-11-17).
  const parentHref = crumbs.length >= 2 ? crumbs[crumbs.length - 2]!.href : null;
  // A phone's title: the page's name — for a record ("Detail", "New", "Edit") with its section, "Banking › Detail".
  const last = crumbs[crumbs.length - 1]?.label ?? "";
  const title = ["Detail", "New", "Edit"].includes(last) && crumbs.length >= 2 ? `${crumbs[crumbs.length - 2]!.label} › ${last}` : last;
  const [searching, setSearching] = useState(false);

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background backdrop-blur-md">
    <div className="flex h-14 items-center gap-2 px-3 md:gap-3 md:px-4">
      {/* On a phone the menu is the dock's More (2026-11-17); tablets and up keep this. */}
      <SidebarTrigger className="hidden md:inline-flex" />
      <BackButton parentHref={parentHref} />

      {/* A phone: the page's name only. */}
      {title && <span className="min-w-0 flex-1 truncate text-base font-semibold text-foreground md:hidden">{title}</span>}

      {/* Breadcrumbs */}
      {crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1 text-sm md:flex">
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

      <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-2">
        <SplitButton />
        <GlobalSearch />
        <button
          type="button"
          onClick={() => setSearching((v) => !v)}
          aria-label={searching ? "Close search" : "Search"}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground sm:hidden"
        >
          {searching ? <X className="h-[18px] w-[18px]" /> : <Search className="h-[18px] w-[18px]" />}
        </button>
        <div className="hidden sm:block"><CurrencyPicker /></div>
        <button
          aria-label="Notifications"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground"
        >
          <Bell className="h-[18px] w-[18px]" />
          <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-primary" />
        </button>
      </div>
    </div>
    {/* A phone's search, full width under the bar. */}
    {searching && (
      <div className="border-t border-border px-3 py-2 sm:hidden">
        <GlobalSearch phone onDone={() => setSearching(false)} />
      </div>
    )}
    </header>
  );
}
