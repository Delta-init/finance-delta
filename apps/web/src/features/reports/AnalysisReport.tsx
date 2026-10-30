"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChevronDown, ChevronRight, Search, X, type LucideIcon } from "lucide-react";
import { ANALYSIS_DIMENSION_LABELS, type AnalysisGroup, type AnalysisRecord, type AnalysisReport } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ExportButton } from "@/components/ui/export-button";
import { DateRangeQuick, rangeDates, useUrlDateRange } from "@/components/ui/date-range-quick";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUrlParam, writeQuery } from "@/lib/url-state";
import { cn } from "@/lib/utils";
import { useAnalysisReport } from "./api";

/*
 * The Expense and Revenue reports (the user, 2026-10-24: "a report on expenses and revenue — all expenses, by
 * category, employee-wise, department-wise, with more filters; the same for revenue"). One screen for both: the
 * period, what it counts by (expense or paid date; invoiced or collected), the dimension to group by, a filter for
 * every dimension, the totals, a chart, the groups (a category opens into its subcategories), and — a group clicked —
 * its records, each opening its own page. Everything sits in the address bar, so a link keeps the view. Exports use
 * exactly what is on screen.
 */

export interface AnalysisConfig {
  kind: "expense" | "revenue";
  title: string;
  description: string;
  icon: LucideIcon;
  bases: { key: string; label: string }[];
  /** The dimensions it can group by, in the order offered. */
  groupBys: string[];
  /** The dimensions it can filter by. */
  filters: string[];
  /** The cards on top. */
  cards: (r: AnalysisReport) => { label: string; minor: number | undefined; hint?: string; tone?: string }[];
  /** "P&L expenses only" (expenses). */
  pnl?: boolean;
  /** Dimensions that mean nothing under a basis (revenue's method and bank under Invoiced). */
  hidden?: (basis: string) => string[];
}

const ALL = "__all";
const label = (dim: string) => ANALYSIS_DIMENSION_LABELS[dim as keyof typeof ANALYSIS_DIMENSION_LABELS] ?? dim;

export function AnalysisReportView({ config }: { config: AnalysisConfig }) {
  const router = useRouter();
  const search = useSearchParams();
  // A report opens on this month, not all time; All time is then a choice of its own (?range=all), and a link with its
  // own range keeps it.
  const urlPeriod = useUrlDateRange({ fromKey: "from", toKey: "to" });
  const unset = !search.get("range") && !search.get("from") && !search.get("to");
  const period = unset
    ? { ...urlPeriod, range: "month" as const, ...rangeDates("month"), setRange: (k: Parameters<typeof urlPeriod.setRange>[0]) => (k === "all" ? writeQuery({ range: "all" }) : urlPeriod.setRange(k)) }
    : { ...urlPeriod, setRange: (k: Parameters<typeof urlPeriod.setRange>[0]) => (k === "all" ? writeQuery({ range: "all", from: null, to: null }) : urlPeriod.setRange(k)) };
  const [basis, setBasis] = useUrlParam("basis", config.bases[0]!.key, { allowed: config.bases.map((b) => b.key) });
  const hidden = config.hidden?.(basis) ?? [];
  const groupBys = config.groupBys.filter((g) => !hidden.includes(g));
  const [groupBy, setGroupBy] = useUrlParam("by", groupBys[0]!, { allowed: groupBys });
  const [pnl, setPnl] = useUrlParam("pnl", "0");
  const [q, setQ] = useUrlParam("q", "");
  const [typed, setTyped] = useState(q);
  const filters: Record<string, string> = Object.fromEntries(config.filters.filter((d) => !hidden.includes(d)).map((d) => [d, search.get(`f_${d}`) ?? ""] as [string, string]).filter(([, v]) => v));

  const params: Record<string, string> = { from: period.from, to: period.to, basis, groupBy, q, ...(config.pnl && pnl === "1" ? { pnl: "1" } : {}), ...filters };
  const { data, isLoading, isPlaceholderData: refreshing, error } = useAnalysisReport(config.kind, params);
  const currency = data?.currency ?? "AED";
  // A group clicked: its records, by the dimension it groups (a subcategory under a category).
  const [open, setOpen] = useState<{ g: AnalysisGroup; dim: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const setFilter = (dim: string, key: string) => writeQuery({ [`f_${dim}`]: key === ALL ? null : key });
  const clearAll = () => writeQuery(Object.fromEntries([...config.filters.map((d) => [`f_${d}`, null]), ["q", null], ["pnl", null]]));
  const nameOf = (dim: string, key: string) => data?.options[dim]?.find((o) => o.key === key)?.name ?? key;
  const active = Object.entries(filters);

  const chart = (data?.groups ?? []).slice(0, 12).map((g) => ({ name: g.name.length > 28 ? `${g.name.slice(0, 27)}…` : g.name, amount: g.amountMinor / 100 }));
  const total = data?.totals.amountMinor ?? 0;
  // Revenue under Invoiced: collected and still owed beside each invoiced amount.
  const cash = !!data?.groups.some((g) => g.collectedMinor !== undefined);
  const cols = cash ? 6 : 4;

  return (
    <div className="space-y-5 p-6">
      <PageHeader icon={config.icon} title={config.title} description={config.description}
        action={data ? <ExportButton<AnalysisRecord> resource="" filename={`${config.kind}-report`} title={config.title} formats={["excel", "csv", "pdf"]}
          fetchRows={async () => data.records} columns={exportColumns(config, data, hidden)} /> : null} />

      {/* Period, basis and grouping */}
      <div className="flex flex-wrap items-center gap-3">
        <DateRangeQuick value={period} />
        <div className="inline-flex rounded-lg border border-border bg-surface p-0.5" role="tablist" aria-label="Counted by">
          {config.bases.map((b) => (
            <button key={b.key} type="button" role="tab" aria-selected={basis === b.key} onClick={() => setBasis(b.key)}
              className={cn("rounded-md px-2.5 py-1.5 text-xs font-medium sm:text-sm", basis === b.key ? "bg-primary text-primary-foreground shadow-sm" : "text-foreground-muted hover:text-foreground")}>
              {b.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-foreground-muted">Group by</span>
          <Select value={groupBy} onValueChange={(v) => { setGroupBy(v); setExpanded(null); }}>
            <SelectTrigger className="h-9 w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>{groupBys.map((g) => <SelectItem key={g} value={g}>{label(g)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          {config.filters.filter((d) => !hidden.includes(d)).map((dim) => {
            const options = data?.options[dim] ?? [];
            return (
              <div key={dim} className="w-[170px] space-y-1">
                <p className="text-xs font-medium text-foreground-muted">{label(dim)}</p>
                <Select value={filters[dim] ?? ALL} onValueChange={(v) => setFilter(dim, v)}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="All" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All</SelectItem>
                    {options.map((o) => <SelectItem key={o.key} value={o.key}>{o.name} ({o.count})</SelectItem>)}
                    {filters[dim] && !options.some((o) => o.key === filters[dim]) && <SelectItem value={filters[dim]!}>{filters[dim]}</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
          <form className="relative w-[220px]" onSubmit={(e) => { e.preventDefault(); setQ(typed.trim()); }}>
            <p className="mb-1 text-xs font-medium text-foreground-muted">Search</p>
            <Search className="absolute bottom-2.5 left-3 h-4 w-4 text-foreground-subtle" />
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} onBlur={() => setQ(typed.trim())} placeholder="Number or words…" className="h-9 pl-9" />
          </form>
          {config.pnl && (
            <label className="flex h-9 items-center gap-2 text-sm">
              <input type="checkbox" checked={pnl === "1"} onChange={(e) => setPnl(e.target.checked ? "1" : "0")} className="h-4 w-4 accent-[var(--primary)]" />
              P&amp;L expenses only
            </label>
          )}
          {(active.length > 0 || q || pnl === "1") && (
            <Button variant="ghost" size="sm" onClick={() => { setTyped(""); clearAll(); }}>Clear filters</Button>
          )}
        </CardContent>
        {active.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2">
            {active.map(([dim, key]) => (
              <button key={dim} type="button" onClick={() => setFilter(dim, ALL)}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/15">
                {label(dim)}: {nameOf(dim, key)} <X className="h-3 w-3" />
              </button>
            ))}
          </div>
        )}
      </Card>

      {error ? (
        <Card><CardContent className="p-6 text-sm text-danger">{(error as Error).message || "The report didn't load."}</CardContent></Card>
      ) : (
        <>
          {/* Cards */}
          <div className={cn("grid grid-cols-2 gap-3 transition-opacity lg:grid-cols-4", refreshing && "opacity-60")} aria-busy={refreshing}>
            {isLoading || !data
              ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24" />)
              : config.cards(data).map((c) => (
                <Card key={c.label}><CardContent className="p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">{c.label}</p>
                  {c.minor === undefined
                    ? <p className="mt-1 text-2xl font-bold">{c.hint}</p>
                    : <MoneyDisplay minor={c.minor} currency={currency} className={cn("mt-1 block text-2xl font-bold", c.tone)} />}
                  {c.minor !== undefined && c.hint && <p className="mt-0.5 text-xs text-foreground-muted">{c.hint}</p>}
                </CardContent></Card>
              ))}
          </div>

          <div className={cn("grid gap-5 transition-opacity lg:grid-cols-5", refreshing && "pointer-events-none opacity-60")}>
            {/* Groups */}
            <Card className="lg:col-span-3">
              <CardHeader className="pb-2"><CardTitle className="text-base">By {label(groupBy).toLowerCase()}</CardTitle></CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="border-y border-border bg-surface-muted text-xs text-foreground-muted">
                    <tr><th className="px-4 py-2 text-left font-medium">{label(groupBy)}</th><th className="px-3 py-2 text-right font-medium">Count</th>
                      <th className="px-3 py-2 text-right font-medium">{cash ? "Invoiced" : "Amount"}</th>
                      {cash && <><th className="px-3 py-2 text-right font-medium">Collected</th><th className="px-3 py-2 text-right font-medium">Still owed</th></>}
                      <th className="px-4 py-2 text-right font-medium">Share</th></tr>
                  </thead>
                  <tbody>
                    {isLoading && <tr><td colSpan={cols} className="px-4 py-8"><Skeleton className="h-24 w-full" /></td></tr>}
                    {!isLoading && !data?.groups.length && <tr><td colSpan={cols} className="px-4 py-10 text-center text-foreground-muted">Nothing in this period with these filters.</td></tr>}
                    {data?.groups.map((g) => (
                      <Fragment key={g.key}>
                        <GroupRow g={g} total={total} currency={currency} cash={cash} onOpen={() => setOpen({ g, dim: groupBy })}
                          expander={g.sub?.length ? (
                            <button type="button" onClick={(e) => { e.stopPropagation(); setExpanded(expanded === g.key ? null : g.key); }}
                              className="text-foreground-subtle hover:text-foreground" aria-label="Subcategories">
                              {expanded === g.key ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          ) : null} />
                        {expanded === g.key && g.sub?.map((s) => (
                          <GroupRow key={s.key} g={s} total={total} currency={currency} nested
                            onOpen={() => setOpen({ g: { ...s, name: `${g.name} › ${s.name}` }, dim: "subcategory" })} />
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                  {!!data?.groups.length && (
                    <tfoot className="border-t border-border font-semibold">
                      <tr><td className="px-4 py-2">Total</td><td className="px-3 py-2 text-right tabular-nums">{data.totals.count}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right"><MoneyDisplay minor={total} currency={currency} /></td><td className="px-4 py-2" /></tr>
                    </tfoot>
                  )}
                </table>
              </CardContent>
            </Card>

            {/* Chart */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2"><CardTitle className="text-base">Top {Math.min(12, data?.groups.length ?? 0)}</CardTitle></CardHeader>
              <CardContent>
                {!chart.length ? <p className="py-10 text-center text-sm text-foreground-muted">No figures.</p> : (
                  <div style={{ height: Math.max(180, chart.length * 30) }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart layout="vertical" data={chart} margin={{ left: 4, right: 16, top: 4, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                        <XAxis type="number" tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} tickLine={false} axisLine={false} fontSize={11} />
                        <YAxis type="category" dataKey="name" width={130} tickLine={false} axisLine={false} fontSize={11} />
                        <Tooltip formatter={(v: number) => [`${currency} ${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`, "Amount"]} />
                        <Bar dataKey="amount" fill="var(--primary)" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* By month */}
          {(data?.months.length ?? 0) > 1 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">By month</CardTitle></CardHeader>
              <CardContent>
                <div className="h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data!.months.map((m) => ({ name: m.month, amount: m.amountMinor / 100 }))} margin={{ left: 4, right: 8, top: 4, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
                      <YAxis tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} tickLine={false} axisLine={false} fontSize={11} width={44} />
                      <Tooltip formatter={(v: number) => [`${currency} ${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`, "Amount"]} />
                      <Bar dataKey="amount" fill="var(--primary)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Every record */}
          <Records title="Every record" records={data?.records ?? []} currency={currency} capped={!!data?.capped} onOpen={(r) => router.push(r.href)} isLoading={isLoading} isFetching={refreshing} />
        </>
      )}

      {open && data && (
        <Dialog open onOpenChange={(o) => { if (!o) setOpen(null); }}>
          <DialogContent className="max-w-4xl">
            <DialogHeader>
              <DialogTitle>{open.g.name}</DialogTitle>
              <DialogDescription>
                {open.g.count} record{open.g.count === 1 ? "" : "s"} · <MoneyDisplay minor={open.g.amountMinor} currency={currency} />
                {open.g.collectedMinor !== undefined && <> invoiced · <MoneyDisplay minor={open.g.collectedMinor} currency={currency} className="text-success" /> collected
                  {(open.g.owedMinor ?? 0) > 0 && <> · <MoneyDisplay minor={open.g.owedMinor ?? 0} currency={currency} className="text-warning" /> still owed</>}</>}
              </DialogDescription>
            </DialogHeader>
            <Records records={data.records.filter((r) => (r.dims[open.dim] ?? "__none") === open.g.key)}
              currency={currency} capped={data.capped} onOpen={(r) => router.push(r.href)} compact />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function GroupRow({ g, total, currency, cash, onOpen, expander, nested }: { g: AnalysisGroup; total: number; currency: string; cash?: boolean; onOpen: () => void; expander?: ReactNode; nested?: boolean }) {
  const share = total ? Math.round((g.amountMinor / total) * 1000) / 10 : 0;
  return (
    <tr className={cn("cursor-pointer border-t border-border hover:bg-surface-muted", nested && "bg-surface-muted/50 text-[13px]")} onClick={onOpen}>
      <td className={cn("px-4 py-2", nested && "pl-11")}>
        <div className="flex items-center gap-2">{expander}<span className={cn(!nested && "font-medium")}>{g.name}</span></div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-foreground-muted">{g.count}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right"><MoneyDisplay minor={g.amountMinor} currency={currency} className={cn(g.amountMinor < 0 && "text-danger")} /></td>
      {cash && <>
        <td className="whitespace-nowrap px-3 py-2 text-right"><MoneyDisplay minor={g.collectedMinor ?? 0} currency={currency} className="text-success" /></td>
        <td className="whitespace-nowrap px-3 py-2 text-right">{(g.owedMinor ?? 0) > 0 ? <MoneyDisplay minor={g.owedMinor ?? 0} currency={currency} className="text-warning" /> : <span className="text-foreground-subtle">—</span>}</td>
      </>}
      <td className="px-4 py-2">
        <div className="flex items-center justify-end gap-2">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted"><span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, share))}%` }} /></span>
          <span className="w-12 text-right text-xs tabular-nums text-foreground-muted">{share}%</span>
        </div>
      </td>
    </tr>
  );
}

function Records({ title, records, currency, capped, onOpen, isLoading, isFetching, compact }: {
  title?: string; records: AnalysisRecord[]; currency: string; capped: boolean; onOpen: (r: AnalysisRecord) => void; isLoading?: boolean; isFetching?: boolean; compact?: boolean;
}) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(compact ? 10 : 25);
  const rows = useMemo(() => records.slice((page - 1) * size, page * size), [records, page, size]);
  const columns: Column<AnalysisRecord>[] = [
    { key: "date", header: "Date", cell: (r) => <span className="whitespace-nowrap text-foreground-muted">{r.date}</span> },
    { key: "number", header: "Number", cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: "title", header: "For", cell: (r) => <span className="block max-w-[220px] truncate" title={r.title}>{r.title}</span> },
    { key: "detail", header: "Details", cell: (r) => <span className="block max-w-[280px] truncate text-xs text-foreground-muted" title={r.detail}>{r.detail || "—"}</span> },
    ...(records.some((r) => r.collectedMinor !== undefined) ? cashColumns(currency) : [
      { key: "amount", header: "Amount", align: "right", cell: (r) => <MoneyDisplay minor={r.amountMinor} currency={currency} className={cn("font-medium", r.amountMinor < 0 && "text-danger")} /> },
    ] as Column<AnalysisRecord>[]),
  ];
  const table = (
    <DataTable columns={columns} data={rows} getRowId={(r) => r.id} total={records.length} page={page} pageSize={size}
      onPageChange={setPage} onPageSizeChange={(n) => { setSize(n); setPage(1); }} onRowClick={onOpen} isLoading={isLoading} isFetching={isFetching}
      emptyMessage="No records." />
  );
  return title ? (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {capped && <p className="text-xs text-warning">Only the newest {records.length.toLocaleString()} are listed — narrow the period or filters to see the rest. The totals count them all.</p>}
      </CardHeader>
      <CardContent className="p-0">{table}</CardContent>
    </Card>
  ) : <div className="max-h-[65vh] overflow-y-auto">{table}</div>;
}

/**
 * Revenue under Invoiced (the user, 2026-10-30: a part-paid invoice showed its whole total): what has come in on each
 * invoice, "of" its total when part-paid, and what is still owed. A credit note has no payments: its amount, as before.
 */
function cashColumns(currency: string): Column<AnalysisRecord>[] {
  return [
    { key: "collected", header: "Collected", align: "right", cell: (r) => r.collectedMinor === undefined
      ? <MoneyDisplay minor={r.amountMinor} currency={currency} className={cn("font-medium", r.amountMinor < 0 && "text-danger")} />
      : (
        <div className="whitespace-nowrap text-right">
          <MoneyDisplay minor={r.collectedMinor} currency={currency} className="font-medium" />
          {r.collectedMinor !== r.amountMinor && <div className="text-[11px] text-foreground-muted">of <MoneyDisplay minor={r.amountMinor} currency={currency} /></div>}
        </div>
      ) },
    { key: "owed", header: "Still owed", align: "right", cell: (r) => (r.owedMinor ?? 0) > 0
      ? <MoneyDisplay minor={r.owedMinor ?? 0} currency={currency} className="text-warning" />
      : <span className="text-foreground-subtle">—</span> },
  ];
}

/** The export: the records on screen, with a column for every dimension. */
function exportColumns(config: AnalysisConfig, data: AnalysisReport, hidden: string[]) {
  const name = (dim: string, key: string | undefined) => data.options[dim]?.find((o) => o.key === key)?.name ?? key ?? "";
  return [
    { header: "Date", value: (r: AnalysisRecord) => r.date },
    { header: "Number", value: (r: AnalysisRecord) => r.number },
    { header: "For", value: (r: AnalysisRecord) => r.title },
    { header: "Details", value: (r: AnalysisRecord) => r.detail },
    ...[...config.groupBys, ...config.filters].filter((d, i, all) => all.indexOf(d) === i && d !== "month" && !hidden.includes(d))
      .map((dim) => ({ header: label(dim), value: (r: AnalysisRecord) => name(dim, r.dims[dim]) })),
    { header: `Amount (${data.currency})`, value: (r: AnalysisRecord) => r.amountMinor / 100 },
    ...(data.records.some((r) => r.collectedMinor !== undefined) ? [
      { header: `Collected (${data.currency})`, value: (r: AnalysisRecord) => (r.collectedMinor === undefined ? "" : r.collectedMinor / 100) },
      { header: `Still owed (${data.currency})`, value: (r: AnalysisRecord) => (r.owedMinor === undefined ? "" : r.owedMinor / 100) },
    ] : []),
  ];
}
