"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, DollarSign, Loader2, Search, TrendingDown, TrendingUp, Wallet, X } from "lucide-react";
import type { DailyBreakdown, DailyBreakdownKind, DailyBreakdownRecord } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExportButton } from "@/components/ui/export-button";
import { FilterToggle } from "@/components/ui/filter-toggle";
import type { ExportColumn } from "@/lib/export";
import { ApiError } from "@/lib/api";
import { useCurrency } from "@/lib/currency-context";
import { countFilters, useUrlParam, useUrlText } from "@/lib/url-state";
import { useDailyBreakdown } from "@/features/reports/api";
import { useAllDepartments } from "@/features/departments/api";

/*
 * One day of the Daily Report in a single table (the user, 2026-10-22: "a page for the daily breakdown — the full
 * report of the day in a single table"): every payment received, every expense and every invoice raised that day,
 * from the same records as the report's figures (GET /reports/daily/breakdown, once per kind), so the cards and the
 * totals row add up to that day's row on the Daily Report. An invoice raised and paid the same day is both an
 * "Invoice raised" and a "Payment received" — they are different figures.
 */

const ALL = "__all";
const KINDS = ["income", "revenue", "expense"] as const satisfies readonly DailyBreakdownKind[];
const TYPE_LABEL: Record<DailyBreakdownKind, string> = { income: "Payment received", revenue: "Invoice raised", expense: "Expense" };
const TYPE_TONE: Record<DailyBreakdownKind, "success" | "primary" | "danger"> = { income: "success", revenue: "primary", expense: "danger" };
const TYPE_FILTERS = [
  { value: "all", label: "Everything" },
  { value: "income", label: "Payments received" },
  { value: "revenue", label: "Invoices raised" },
  { value: "expense", label: "Expenses" },
] as const;

interface DayRow extends DailyBreakdownRecord {
  kind: DailyBreakdownKind;
  /** Salesperson and CRM for money in; department and who entered it for an expense. */
  who: string;
  /** What else there is to say: the method or the CRM; an expense's approval. */
  extra: string;
}

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
const shift = (day: string, by: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};
const longDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });

function rowsOf(kind: DailyBreakdownKind, data: DailyBreakdown | undefined): DayRow[] {
  return (data?.records ?? []).map((r) => {
    const g = r.groups;
    if (kind === "expense") {
      return { ...r, kind, who: [g.department, g.submittedBy].filter((x) => x && x !== "—").join(" · "), extra: g.status ?? "" };
    }
    const crm = g.crm && g.crm !== "—" ? g.crm : "";
    return { ...r, kind, who: [g.salesperson !== "—" ? g.salesperson : "", crm].filter(Boolean).join(" · "), extra: kind === "income" ? g.method ?? "" : "" };
  });
}

export default function DailyDayPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = use(params);
  const router = useRouter();
  const { currency, convert } = useCurrency();
  const money = (minor: number) =>
    `${currency} ${(convert(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Kept in the address bar, as on every list (2026-10-22); the department comes along from the Daily Report.
  const [departmentId, setDepartmentId] = useUrlParam("department", ALL);
  const [type, setType] = useUrlParam("type", "all", { allowed: TYPE_FILTERS.map((t) => t.value) });
  const [search, setSearch] = useUrlText("q");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { data: departments } = useAllDepartments();
  const scope = departmentId === ALL ? undefined : departmentId;
  const valid = isDay(date);

  const q = (kind: DailyBreakdownKind) => (valid ? { kind, from: date, to: date, departmentId: scope } : null);
  const income = useDailyBreakdown(q("income"));
  const revenue = useDailyBreakdown(q("revenue"));
  const expense = useDailyBreakdown(q("expense"));
  const loading = income.isLoading || revenue.isLoading || expense.isLoading;
  const failed = income.error ?? revenue.error ?? expense.error;

  const all: DayRow[] = [...rowsOf("income", income.data), ...rowsOf("revenue", revenue.data), ...rowsOf("expense", expense.data)];
  const needle = search.trim().toLowerCase();
  const rows = all.filter((r) =>
    (type === "all" || r.kind === type) &&
    (!needle || [r.number, r.title, r.detail, r.who, r.extra, TYPE_LABEL[r.kind]].some((v) => v?.toLowerCase().includes(needle))),
  );
  const sum = (kind: DailyBreakdownKind, list: DayRow[]) => list.filter((r) => r.kind === kind).reduce((t, r) => t + r.amountMinor, 0);
  // The day as the report has it, whatever is filtered below.
  const day = { income: income.data?.totalMinor ?? 0, expense: expense.data?.totalMinor ?? 0, revenue: revenue.data?.totalMinor ?? 0 };
  const shown = { income: sum("income", rows), expense: sum("expense", rows), revenue: sum("revenue", rows) };
  const net = day.income - day.expense;
  const deptName = departments?.find((d) => d.id === departmentId)?.name;
  const go = (to: string) => router.push(`/reports/daily/${to}${scope ? `?department=${scope}` : ""}`);

  const exportColumns: ExportColumn<DayRow>[] = [
    { header: "Date", value: (r) => r.date },
    { header: "Type", value: (r) => TYPE_LABEL[r.kind] },
    { header: "Number", value: (r) => r.number },
    { header: "Customer / category", value: (r) => r.title },
    { header: "Details", value: (r) => r.detail },
    { header: "Salesperson / department", value: (r) => r.who },
    { header: "Method / status", value: (r) => r.extra },
    { header: "In", value: (r) => (r.kind === "income" ? r.amountMinor / 100 : "") },
    { header: "Out", value: (r) => (r.kind === "expense" ? r.amountMinor / 100 : "") },
    { header: "Invoiced", value: (r) => (r.kind === "revenue" ? r.amountMinor / 100 : "") },
    { header: "Currency", value: (r) => r.currency },
  ];

  const cards = [
    { label: "Income", value: day.income, Icon: DollarSign, className: "text-success" },
    { label: "Expenses", value: day.expense, Icon: Wallet, className: "text-danger" },
    { label: "Revenue (Invoiced)", value: day.revenue, Icon: TrendingUp, className: "text-foreground" },
    { label: "Net (Income − Expenses)", value: net, Icon: net >= 0 ? TrendingUp : TrendingDown, className: net >= 0 ? "text-success" : "text-danger" },
  ];

  if (!valid) {
    return (
      <div className="p-6">
        <Card className="px-5 py-16 text-center text-sm text-foreground-muted">
          “{date}” is not a day. <Link href="/reports/daily" className="text-primary hover:underline">Back to the Daily Report</Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        icon={CalendarDays}
        title={longDay(date)}
        description={`Everything on the Daily Report for this day, in one table${deptName ? ` · ${deptName}` : ""} — payments received, invoices raised and expenses.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => go(shift(date, -1))} aria-label="The day before">
              <ChevronLeft className="h-4 w-4" /> {shift(date, -1)}
            </Button>
            <Button variant="outline" onClick={() => go(shift(date, 1))} aria-label="The day after">
              {shift(date, 1)} <ChevronRight className="h-4 w-4" />
            </Button>
            <FilterToggle open={filtersOpen} onToggle={() => setFiltersOpen((o) => !o)} count={countFilters(type, scope ?? "")} />
            <ExportButton<DayRow>
              resource="reports/daily/breakdown"
              fetchRows={async () => rows}
              columns={exportColumns}
              filename={`daily-${date}`}
              title={`Daily report — ${date}${deptName ? ` — ${deptName}` : ""}`}
              size="md"
              disabled={rows.length === 0}
            />
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Number, customer, category, salesperson…" className="pl-8" />
        </div>
        <Input type="date" value={date} onChange={(e) => e.target.value && go(e.target.value)} className="w-[160px]" aria-label="Go to a day" />
        {filtersOpen && (<>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TYPE_FILTERS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {(departments?.length ?? 0) > 0 && (
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger className="w-[190px]"><SelectValue placeholder="All departments" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All departments</SelectItem>
                {departments?.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {(type !== "all" || scope) && (
            <Button variant="ghost" size="sm" onClick={() => { setType("all"); setDepartmentId(ALL); }}>
              <X className="h-4 w-4" /> Clear
            </Button>
          )}
        </>)}
        {scope && <span className="text-xs text-foreground-subtle">Income &amp; revenue scoped to this department; expenses are org-wide.</span>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, value, Icon, className }) => (
          <Card key={label} className="p-5">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-foreground-muted">
              <Icon className="h-3.5 w-3.5" /> {label}
            </p>
            <p className={`mt-2 text-2xl font-bold font-numeric ${className}`}>{loading ? "…" : money(value)}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></div>
        ) : failed ? (
          <p className="py-16 text-center text-sm text-foreground-muted">
            {failed instanceof ApiError && failed.status === 404 ? "This needs the latest finance API — ask for it to be updated." : failed instanceof ApiError ? failed.message : "Could not load the day."}
          </p>
        ) : rows.length === 0 ? (
          <p className="py-16 text-center text-sm text-foreground-muted">
            {all.length === 0 ? "Nothing was received, spent or invoiced on this day." : "Nothing matches these filters."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                  <th className="px-4 py-3 text-left">Type</th>
                  <th className="px-4 py-3 text-left">Number</th>
                  <th className="px-4 py-3 text-left">Customer / Category</th>
                  <th className="px-4 py-3 text-left">Details</th>
                  <th className="px-4 py-3 text-left">Salesperson / Department</th>
                  <th className="px-4 py-3 text-right">In</th>
                  <th className="px-4 py-3 text-right">Out</th>
                  <th className="px-4 py-3 text-right">Invoiced</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.kind}:${r.id}`} className="border-b border-border last:border-0 hover:bg-surface-muted/50">
                    <td className="whitespace-nowrap px-4 py-3"><Badge tone={TYPE_TONE[r.kind]}>{TYPE_LABEL[r.kind]}</Badge></td>
                    <td className="whitespace-nowrap px-4 py-3 font-medium">
                      <Link href={r.href} className="text-primary hover:underline">{r.number || "—"}</Link>
                    </td>
                    <td className="max-w-[220px] px-4 py-3"><span className="line-clamp-2">{r.title || "—"}</span></td>
                    <td className="max-w-[260px] px-4 py-3 text-foreground-muted">
                      <span className="line-clamp-2">{r.kind === "income" ? r.detail : r.kind === "expense" ? r.detail || "—" : r.extra || "—"}</span>
                      {r.kind === "expense" && r.extra && <span className="text-xs text-foreground-subtle">{r.extra}</span>}
                    </td>
                    <td className="px-4 py-3 text-foreground-muted">{r.who || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-numeric text-success">{r.kind === "income" ? money(r.amountMinor) : ""}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-numeric text-danger">{r.kind === "expense" ? money(r.amountMinor) : ""}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-numeric">{r.kind === "revenue" ? money(r.amountMinor) : ""}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-surface-muted/50 font-semibold">
                  <td className="px-4 py-3" colSpan={5}>
                    Total · {rows.length} record{rows.length === 1 ? "" : "s"}
                    {rows.length !== all.length && <span className="font-normal text-foreground-muted"> (of {all.length})</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-numeric text-success">{money(shown.income)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-numeric text-danger">{money(shown.expense)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-numeric">{money(shown.revenue)}</td>
                </tr>
                <tr className="bg-surface-muted/50 text-sm">
                  <td className="px-4 pb-3" colSpan={5}>Net (in − out)</td>
                  <td className={`whitespace-nowrap px-4 pb-3 text-right font-numeric font-semibold ${shown.income - shown.expense >= 0 ? "text-success" : "text-danger"}`} colSpan={2}>
                    {money(shown.income - shown.expense)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
