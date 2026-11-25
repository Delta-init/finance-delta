"use client";

import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChevronDown, ChevronRight, FileSpreadsheet, Loader2, Search, X, type LucideIcon } from "lucide-react";
import { ANALYSIS_DIMENSION_LABELS, type AnalysisGroup, type AnalysisRecord, type AnalysisReport } from "@delta/shared";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ExportButton } from "@/components/ui/export-button";
import { exportWorkbook } from "@/lib/export";
import { DateRangeQuick, rangeDates, useUrlDateRange } from "@/components/ui/date-range-quick";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUrlParam, writeQuery } from "@/lib/url-state";
import { cn } from "@/lib/utils";
import { fetchAnalysisReport, useAnalysisReport } from "./api";
import { toast } from "@/lib/toast";

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
  // Which currency the table, chart and records show, when the period has more than one (2026-11-07).
  const [cur, setCur] = useUrlParam("cur", "");
  const [typed, setTyped] = useState(q);
  const filters: Record<string, string> = Object.fromEntries(config.filters.filter((d) => !hidden.includes(d)).map((d) => [d, search.get(`f_${d}`) ?? ""] as [string, string]).filter(([, v]) => v));

  const params: Record<string, string> = { from: period.from, to: period.to, basis, groupBy, q, currency: cur, ...(config.pnl && pnl === "1" ? { pnl: "1" } : {}), ...filters };
  const { data, isLoading, isPlaceholderData: refreshing, error } = useAnalysisReport(config.kind, params);
  const currency = data?.currency ?? "AED";
  // Every currency's cards, never added together (the user, 2026-11-07: an INR expense showed as AED) — from an API
  // older than that, the one currency it gives.
  const perCurrency = data ? (data.byCurrency?.length ? data.byCurrency : [{ ...data.totals, currency }]) : [];
  const cardsByCurrency = data ? perCurrency.map((t) => ({ currency: t.currency, cards: config.cards({ ...data, currency: t.currency, totals: t }) })) : [];
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
  // The other organization's money beside it (2026-11-25: Bangalore's rupees on Delta HQ's revenue), never added.
  const other = data?.other ?? null;
  const otherLabel = other ? placeLabel(other.organizationName) : "";
  const cols = (cash ? 6 : 4) + (other ? 1 : 0);

  // Exports ask for the report afresh, for exactly what is picked now (2026-11-26: Collected exported the Invoiced
  // figures still on screen while it loaded). `exported` is that answer, for the export's columns to read.
  const exported = useRef<AnalysisReport | null>(null);
  const [bySalesperson, setBySalesperson] = useState(false);
  const fresh = async () => {
    const r = await fetchAnalysisReport(config.kind, params);
    if (r.basis !== basis) throw new Error("The report changed while exporting — try again");
    exported.current = r;
    return r;
  };
  const runBySalesperson = async () => {
    setBySalesperson(true);
    try {
      const r = await fresh();
      if (!r.records.length && !r.other?.records.length) { toast.error("Nothing to export for the current filters"); return; }
      exportBySalesperson(config, r, basis, period.from, period.to);
      toast.success(`Exported ${basis === "collected" ? "collected payments" : "invoices"} by salesperson`);
    } catch (e) {
      toast.error((e as Error).message || "Export failed");
    } finally {
      setBySalesperson(false);
    }
  };

  return (
    <div className="space-y-5 p-6">
      <PageHeader icon={config.icon} title={config.title} description={config.description}
        action={data ? (
          <div className="flex flex-wrap items-center gap-2">
            {config.kind === "revenue" && (
              <Button variant="outline" size="sm" onClick={runBySalesperson} disabled={bySalesperson}>
                {bySalesperson ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-1.5 h-4 w-4 text-success" />} Excel by salesperson
              </Button>
            )}
            <ExportButton<AnalysisRecord> resource="" filename={`${config.kind}-report-${config.bases.find((b) => b.key === basis)?.label.toLowerCase() ?? basis}`}
              title={`${config.title} — ${config.bases.find((b) => b.key === basis)?.label ?? basis}`} formats={["excel", "csv", "pdf"]}
              fetchRows={async () => (await fresh()).records} columns={exportColumns(config, basis, () => exported.current ?? data, hidden)} />
          </div>
        ) : null} />

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
        {(data?.currencies?.length ?? 0) > 1 && (
          <div className="inline-flex rounded-lg border border-border bg-surface p-0.5" role="tablist" aria-label="Currency">
            {data!.currencies!.map((c) => (
              <button key={c} type="button" role="tab" aria-selected={currency === c} onClick={() => { setCur(c); setExpanded(null); }}
                className={cn("rounded-md px-2.5 py-1.5 text-xs font-medium sm:text-sm", currency === c ? "bg-primary text-primary-foreground shadow-sm" : "text-foreground-muted hover:text-foreground")}>
                {c}
              </button>
            ))}
          </div>
        )}
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
              : (cardsByCurrency[0]?.cards ?? []).map((first, i) => (
                // A line per currency, the organization's first, as the Expenses list's cards (2026-11-07).
                <Card key={first.label}><CardContent className="space-y-1.5 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">{first.label}</p>
                  {cardsByCurrency.map(({ currency: cc, cards }) => {
                    const c = cards[i]!;
                    const many = cardsByCurrency.length > 1;
                    return (
                      <div key={cc} className={cn(many && "flex flex-wrap items-baseline justify-between gap-x-2")}>
                        {c.minor === undefined
                          ? <p className={cn("font-bold", many ? "text-lg" : "mt-1 text-2xl")}>{c.hint}</p>
                          : <MoneyDisplay minor={c.minor} currency={cc} className={cn("block font-bold tabular-nums", many ? "text-lg" : "mt-1 text-2xl", c.tone)} />}
                        {c.minor !== undefined && c.hint && <p className={cn("text-xs text-foreground-muted", !many && "mt-0.5")}>{c.hint}</p>}
                      </div>
                    );
                  })}
                </CardContent></Card>
              ))}
            {other && !isLoading && (
              <Card className="border-primary/40"><CardContent className="space-y-1.5 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                  {basis === "collected" ? "Collected" : "Invoiced"} in {otherLabel} <PlaceTag label={otherLabel} />
                </p>
                <MoneyDisplay minor={other.amountMinor} currency={other.currency} className="mt-1 block text-2xl font-bold tabular-nums text-primary" />
                <p className="text-xs text-foreground-muted">{other.count.toLocaleString()} {basis === "collected" ? "payment" : "record"}{other.count === 1 ? "" : "s"} · {other.organizationName} · in {other.currency}, not added above</p>
              </CardContent></Card>
            )}
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
                      {other && <th className="whitespace-nowrap bg-primary/5 px-3 py-2 text-right font-medium">{otherLabel} ({other.currency})</th>}
                      <th className="px-4 py-2 text-right font-medium">Share</th></tr>
                  </thead>
                  <tbody>
                    {isLoading && <tr><td colSpan={cols} className="px-4 py-8"><Skeleton className="h-24 w-full" /></td></tr>}
                    {!isLoading && !data?.groups.length && <tr><td colSpan={cols} className="px-4 py-10 text-center text-foreground-muted">Nothing in this period with these filters.</td></tr>}
                    {data?.groups.map((g) => (
                      <Fragment key={g.key}>
                        <GroupRow g={g} total={total} currency={currency} cash={cash} other={other ? { currency: other.currency, label: otherLabel } : undefined} onOpen={() => setOpen({ g, dim: groupBy })}
                          expander={g.sub?.length ? (
                            <button type="button" onClick={(e) => { e.stopPropagation(); setExpanded(expanded === g.key ? null : g.key); }}
                              className="text-foreground-subtle hover:text-foreground" aria-label="Subcategories">
                              {expanded === g.key ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          ) : null} />
                        {expanded === g.key && g.sub?.map((s) => (
                          <GroupRow key={s.key} g={s} total={total} currency={currency} nested other={other ? { currency: other.currency, label: otherLabel } : undefined}
                            onOpen={() => setOpen({ g: { ...s, name: `${g.name} › ${s.name}` }, dim: "subcategory" })} />
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                  {!!data?.groups.length && (
                    <tfoot className="border-t border-border font-semibold">
                      <tr><td className="px-4 py-2">Total</td><td className="px-3 py-2 text-right tabular-nums">{data.totals.count}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right"><MoneyDisplay minor={total} currency={currency} /></td>
                        {cash && <><td className="px-3 py-2" /><td className="px-3 py-2" /></>}
                        {other && <td className="whitespace-nowrap bg-primary/5 px-3 py-2 text-right text-primary"><MoneyDisplay minor={other.amountMinor} currency={other.currency} /></td>}
                        <td className="px-4 py-2" /></tr>
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
            {other && open.g.other && (
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-sm font-medium">In {otherLabel} <PlaceTag label={otherLabel} /> · {open.g.other.count} · <MoneyDisplay minor={open.g.other.amountMinor} currency={other.currency} className="text-primary" /></p>
                <Records records={other.records.filter((r) => (r.dims[open.dim] ?? "__none") === open.g.key)}
                  currency={other.currency} capped={false} onOpen={() => {}} compact />
                <p className="text-xs text-foreground-muted">These are in {other.organizationName} — switch to it to open one.</p>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function GroupRow({ g, total, currency, cash, other, onOpen, expander, nested }: { g: AnalysisGroup; total: number; currency: string; cash?: boolean; other?: { currency: string; label: string }; onOpen: () => void; expander?: ReactNode; nested?: boolean }) {
  const onlyThere = !!g.other && g.count === 0 && g.amountMinor === 0;
  const share = total ? Math.round((g.amountMinor / total) * 1000) / 10 : 0;
  return (
    <tr className={cn("cursor-pointer border-t border-border hover:bg-surface-muted", nested && "bg-surface-muted/50 text-[13px]")} onClick={onOpen}>
      <td className={cn("px-4 py-2", nested && "pl-11")}>
        <div className="flex items-center gap-2">{expander}<span className={cn(!nested && "font-medium")}>{g.name}</span>{onlyThere && other && <PlaceTag label={`${other.label} only`} />}</div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-foreground-muted">{g.count}{g.other ? <span className="ml-1 text-xs text-primary">+{g.other.count}</span> : null}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right">{onlyThere ? <span className="text-foreground-subtle">—</span> : <MoneyDisplay minor={g.amountMinor} currency={currency} className={cn(g.amountMinor < 0 && "text-danger")} />}</td>
      {cash && <>
        <td className="whitespace-nowrap px-3 py-2 text-right"><MoneyDisplay minor={g.collectedMinor ?? 0} currency={currency} className="text-success" /></td>
        <td className="whitespace-nowrap px-3 py-2 text-right">{(g.owedMinor ?? 0) > 0 ? <MoneyDisplay minor={g.owedMinor ?? 0} currency={currency} className="text-warning" /> : <span className="text-foreground-subtle">—</span>}</td>
      </>}
      {other && (
        <td className="whitespace-nowrap bg-primary/5 px-3 py-2 text-right">
          {g.other ? <span className="inline-flex items-center gap-1.5"><MoneyDisplay minor={g.other.amountMinor} currency={other.currency} className="text-primary" /><PlaceTag label={other.label} /></span> : <span className="text-foreground-subtle">—</span>}
        </td>
      )}
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

/**
 * The export: the report asked afresh (`report()` — read when the rows are written), with a column for every
 * dimension the basis has; revenue under Invoiced also what came in on each invoice and what is still owed.
 */
function exportColumns(config: AnalysisConfig, basis: string, report: () => AnalysisReport, hidden: string[]) {
  const name = (dim: string, key: string | undefined) => report().options[dim]?.find((o) => o.key === key)?.name ?? key ?? "";
  const cur = () => report().currency;
  const invoiced = config.kind === "revenue" && basis === "invoiced";
  return [
    { header: "Date", value: (r: AnalysisRecord) => r.date },
    { header: "Number", value: (r: AnalysisRecord) => r.number },
    { header: "For", value: (r: AnalysisRecord) => r.title },
    { header: "Details", value: (r: AnalysisRecord) => r.detail },
    ...[...config.groupBys, ...config.filters].filter((d, i, all) => all.indexOf(d) === i && d !== "month" && !hidden.includes(d))
      .map((dim) => ({ header: label(dim), value: (r: AnalysisRecord) => name(dim, r.dims[dim]) })),
    { header: invoiced ? "Invoiced" : config.kind === "revenue" ? "Collected" : "Amount", value: (r: AnalysisRecord) => r.amountMinor / 100 },
    ...(invoiced ? [
      { header: "Collected on it", value: (r: AnalysisRecord) => (r.collectedMinor === undefined ? "" : r.collectedMinor / 100) },
      { header: "Still owed", value: (r: AnalysisRecord) => (r.owedMinor === undefined ? "" : r.owedMinor / 100) },
    ] : []),
    { header: "Currency", value: () => cur() },
  ];
}

/** "Delta Banglore" → "Bangalore"; any other organization by its own name. */
function placeLabel(orgName: string): string {
  return /bang?a?lore/i.test(orgName) ? "Bangalore" : orgName;
}

function PlaceTag({ label: text }: { label: string }) {
  return <span className="inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">{text}</span>;
}

/**
 * Excel by salesperson (the user, 2026-11-25: "excel export by each employee and total, each a separate sheet, and an
 * overview with each employee and amount"): an Overview sheet — each salesperson's count and amount here and, beside,
 * in the other organization (rupees, never added) — with a total; then a sheet per salesperson with every record of
 * theirs, both organizations', and their totals. The report asked afresh for the period, basis, filters and search
 * picked (2026-11-26); Collected and Invoiced each get their own columns.
 */
function exportBySalesperson(config: AnalysisConfig, data: AnalysisReport, basis: string, from: string, to: string) {
  const other = data.other ?? null;
  const place = other ? placeLabel(other.organizationName) : "";
  const nameOf = (dim: string, key: string | undefined) => data.options[dim]?.find((o) => o.key === key)?.name ?? key ?? "—";
  type Mine = { name: string; here: AnalysisRecord[]; there: AnalysisRecord[] };
  const people = new Map<string, Mine>();
  const add = (r: AnalysisRecord, where: "here" | "there") => {
    const key = r.dims.salesperson ?? "__none";
    const p = people.get(key) ?? { name: nameOf("salesperson", key), here: [], there: [] };
    p[where].push(r);
    people.set(key, p);
  };
  for (const r of data.records) add(r, "here");
  for (const r of other?.records ?? []) add(r, "there");
  const sum = (rs: AnalysisRecord[]) => Math.round(rs.reduce((s, r) => s + r.amountMinor, 0)) / 100;
  const list = [...people.values()].sort((a, b) => sum(b.here) - sum(a.here) || sum(b.there) - sum(a.there) || a.name.localeCompare(b.name));
  const what = basis === "collected" ? "Collected" : "Invoiced";
  const period = from || to ? `${from || "…"} to ${to || "…"}` : "All time";

  const overview: Array<Array<string | number>> = [
    [`${config.title} — ${what} by salesperson`, period],
    [],
    ["Salesperson", basis === "collected" ? "Payments" : "Records", `${what} (${data.currency})`, ...(other ? [`${place} count`, `${place} (${other.currency})`] : [])],
    ...list.map((p) => [p.name, p.here.length, sum(p.here), ...(other ? [p.there.length, sum(p.there)] : [])]),
    ["Total", data.records.length, sum(data.records), ...(other ? [other.records.length, sum(other.records)] : [])],
  ];
  if (other) overview.push([], [`${place} figures are ${other.organizationName}'s, in ${other.currency} — not converted or added to the ${data.currency} column.`]);
  if (data.capped) overview.push([], [`Only the newest ${data.records.length.toLocaleString()} records are listed — narrow the period for every one.`]);

  const where = (there: boolean) => (there ? place : data.currency === "AED" ? "Dubai" : "Here");
  const theirs = (r: AnalysisRecord, there: boolean) => (other ? [there ? r.amountMinor / 100 : ""] : []);
  // Collected: each payment — its receipt or tax invoice number, the invoice, method and bank. Invoiced: each invoice
  // (a pro-forma's payments as their tax invoices) — what came in on it and what is still owed.
  const sheetOf = (p: Mine) => {
    const collected = basis === "collected";
    const head = collected
      ? ["Date paid", "Number", "Invoice", "Customer", "Course / product", "Method", "Bank account", "Where", `Collected (${data.currency})`, ...(other ? [`${place} (${other.currency})`] : [])]
      : ["Date", "Number", "Customer", "Course / product", "Where", `Invoiced (${data.currency})`, "Collected on it", "Still owed", ...(other ? [`${place} (${other.currency})`] : [])];
    const row = (r: AnalysisRecord, there: boolean) => collected
      ? [r.date, r.number, r.detail.split(" · ")[0] ?? "", r.title, nameOf("course", r.dims.course), nameOf("method", r.dims.method), nameOf("bank", r.dims.bank), where(there),
        there ? "" : r.amountMinor / 100, ...theirs(r, there)]
      : [r.date, r.number, r.title, nameOf("course", r.dims.course), where(there),
        there ? "" : r.amountMinor / 100, there || r.collectedMinor === undefined ? "" : r.collectedMinor / 100, there || r.owedMinor === undefined ? "" : r.owedMinor / 100, ...theirs(r, there)];
    const rows = [...p.here.map((r) => row(r, false)), ...p.there.map((r) => row(r, true))].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const n = p.here.length + p.there.length;
    const owed = Math.round(p.here.reduce((s, r) => s + (r.owedMinor ?? 0), 0)) / 100;
    const got = Math.round(p.here.reduce((s, r) => s + (r.collectedMinor ?? 0), 0)) / 100;
    const total = collected
      ? ["Total", `${n} payment${n === 1 ? "" : "s"}`, "", "", "", "", "", "", sum(p.here), ...(other ? [sum(p.there)] : [])]
      : ["Total", `${n} record${n === 1 ? "" : "s"}`, "", "", "", sum(p.here), got, owed, ...(other ? [sum(p.there)] : [])];
    return { title: p.name, rows: [[p.name, `${what} · ${period}`], [], head, ...rows, total] };
  };
  exportWorkbook(`${config.kind}-${basis}-by-salesperson${from ? `-${from}` : ""}${to ? `-${to}` : ""}`, [{ title: "Overview", rows: overview }, ...list.map(sheetOf)]);
}
