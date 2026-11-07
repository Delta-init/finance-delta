"use client";

import { useState } from "react";
import Link from "next/link";
import { Search, X, ExternalLink, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DateRangeQuick, useUrlDateRange } from "@/components/ui/date-range-quick";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useUrlPage, useUrlParam, useUrlText } from "@/lib/url-state";
import { usePersonLedger } from "./api";
import type { LedgerFact, LedgerKind, LedgerRow } from "./types";

const KINDS: Array<{ key: LedgerKind; label: string }> = [
  { key: "invoice", label: "Invoices raised" },
  { key: "payroll", label: "Payroll" },
  { key: "expense", label: "Expenses" },
  { key: "advance", label: "Salary advances" },
  { key: "one_time", label: "One-time payments" },
];
const KIND_LABEL: Record<LedgerKind, string> = {
  invoice: "Invoice", payroll: "Payroll", expense: "Expense", advance: "Advance", one_time: "One-time payment",
};
const KIND_TONE: Record<LedgerKind, "primary" | "success" | "warning" | "neutral" | "danger"> = {
  invoice: "primary", payroll: "success", expense: "warning", advance: "neutral", one_time: "neutral",
};
const OPEN_LABEL: Record<LedgerKind, string> = {
  invoice: "Open the invoice", payroll: "Open the payroll run", expense: "Open the expense", advance: "Open the expense", one_time: "Open the expense",
};

/** What a row's status reads as, and its colour. */
function statusOf(r: LedgerRow): { text: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const s = r.status;
  if (r.kind === "payroll") {
    if (s === "paid") return { text: "Paid", tone: "success" };
    if (s === "partially_paid") return { text: "Part paid", tone: "warning" };
    if (s === "on_hold") return { text: "Held", tone: "danger" };
    return { text: "Owed", tone: "warning" };
  }
  if (s === "paid" || s === "approved") return { text: s === "paid" ? "Paid" : "Approved", tone: "success" };
  if (s === "partial") return { text: "Part paid", tone: "warning" };
  if (s === "overdue") return { text: "Overdue", tone: "danger" };
  if (s === "submitted") return { text: "Awaiting approval", tone: "neutral" };
  return { text: s ? s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "—", tone: "neutral" };
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * A person's ledger (the user, 2026-11-05): every invoice they raised, each payroll month — its commission inside it —
 * each expense for them, and each salary advance or one-time payment, in one table. Search, the kind, the dates, the
 * order and the page are the server's to apply and kept in the address; a row opens what it is.
 */
export function PersonLedgerTab({ employeeId, keyPrefix = "" }: { employeeId: string; /** "p." in the split pane. */ keyPrefix?: string }) {
  const lk = (key: string) => `${keyPrefix}l${key}`;
  const [page, setPage] = useUrlPage(lk("page"));
  const [size, setSize] = useUrlParam(lk("size"), "25", { page: lk("page"), allowed: ["10", "25", "50", "100"] });
  const [kind, setKind] = useUrlParam<"all" | LedgerKind>(lk("kind"), "all", { page: lk("page"), allowed: ["all", ...KINDS.map((k) => k.key)] });
  const [text, setText, q] = useUrlText(lk("q"), { page: lk("page") });
  const dates = useUrlDateRange({ fromKey: lk("from"), toKey: lk("to"), rangeKey: lk("range"), page: lk("page") });
  const [sort, setSort] = useUrlParam<"desc" | "asc">(lk("sort"), "desc", { page: lk("page"), allowed: ["asc", "desc"] });
  const [open, setOpen] = useState<LedgerRow | null>(null);

  const { data, isLoading, isPlaceholderData } = usePersonLedger(employeeId, {
    page, pageSize: Number(size), kind: kind === "all" ? undefined : kind, q: q || undefined,
    from: dates.from || undefined, to: dates.to || undefined, sort,
  });
  const counts = data?.counts;
  const all = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : undefined;

  const columns: Column<LedgerRow>[] = [
    { key: "date", header: "Date", sortable: true, cell: (r) => <span className="whitespace-nowrap text-foreground-muted">{day(r.date)}</span> },
    { key: "kind", header: "Type", cell: (r) => <Badge tone={KIND_TONE[r.kind]}>{KIND_LABEL[r.kind]}</Badge> },
    { key: "reference", header: "Reference", cell: (r) => <span className="whitespace-nowrap font-medium">{r.reference || "—"}</span> },
    {
      key: "details", header: "Details",
      cell: (r) => (
        <div className="min-w-[180px]">
          <div>{r.title}</div>
          {r.subtitle && <div className="text-xs text-foreground-muted">{r.subtitle}</div>}
        </div>
      ),
    },
    {
      key: "in", header: "Brought in", align: "right",
      cell: (r) => (r.inMinor ? <MoneyDisplay minor={r.inMinor} currency={r.currency} className="font-medium text-success" /> : <span className="text-foreground-muted">—</span>),
    },
    {
      key: "out", header: "Paid / spent", align: "right",
      cell: (r) =>
        r.outMinor ? (
          <MoneyDisplay minor={r.outMinor} currency={r.currency} className={r.counted ? "font-medium" : "text-foreground-muted"} />
        ) : (
          <span className="text-foreground-muted">—</span>
        ),
    },
    { key: "status", header: "Status", cell: (r) => { const s = statusOf(r); return <Badge tone={s.tone}>{s.text}</Badge>; } },
  ];

  return (
    <Card className="space-y-0 overflow-hidden">
      <div className="space-y-3 border-b border-border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ledger-q" className="text-xs">Search</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
              <Input id="ledger-q" value={text} onChange={(e) => setText(e.target.value)} placeholder="IN-, EX-, PAY-, customer…" className="w-64 pl-8" />
              {text && (
                <button type="button" aria-label="Clear search" onClick={() => setText("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-subtle">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <span className="block text-xs font-medium">Dates</span>
            <DateRangeQuick value={dates} />
          </div>
        </div>
        <div className="flex flex-wrap gap-1 text-sm" role="tablist" aria-label="Type">
          {[{ key: "all" as const, label: "All" }, ...KINDS].map((k) => {
            const n = k.key === "all" ? all : counts?.[k.key];
            return (
              <button
                key={k.key}
                type="button"
                role="tab"
                aria-selected={kind === k.key}
                onClick={() => setKind(k.key)}
                className={`rounded-md px-3 py-1.5 font-medium ${kind === k.key ? "bg-primary text-primary-foreground" : "text-foreground-muted hover:bg-surface-muted"}`}
              >
                {k.label}
                {n !== undefined && <span className="ml-1.5 tabular-nums opacity-80">{n}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {data?.capped && (
        <p className="flex items-center gap-2 border-b border-border bg-warning/5 px-4 py-2 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5" />More than 2,000 of one kind — narrow the dates to see the oldest.
        </p>
      )}

      <DataTable
        columns={columns}
        data={data?.rows}
        getRowId={(r) => r.id}
        total={data?.meta.total ?? 0}
        page={data?.meta.page ?? page}
        pageSize={Number(size)}
        sort={{ key: "date", dir: sort }}
        onSortChange={() => setSort(sort === "desc" ? "asc" : "desc")}
        onPageChange={setPage}
        onPageSizeChange={(n) => setSize(String(n) as typeof size)}
        pageSizeOptions={[10, 25, 50, 100]}
        onRowClick={setOpen}
        isLoading={isLoading}
        isFetching={isPlaceholderData}
        viewable={false}
        emptyMessage={q || kind !== "all" || dates.from || dates.to ? "Nothing matches." : "Nothing on their ledger yet."}
      />

      {data && data.totals.length > 0 && (
        <div className="space-y-1 border-t border-border bg-surface-muted/50 px-4 py-3 text-sm">
          {data.totals.map((t) => (
            <div key={t.currency} className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1">
              <span className="text-foreground-muted">{data.totals.length > 1 ? `${t.currency} · ` : ""}{data.meta.total} shown</span>
              <span>Brought in <MoneyDisplay minor={t.inMinor} currency={t.currency} className="font-semibold text-success" /></span>
              <span>Paid / spent <MoneyDisplay minor={t.outMinor} currency={t.currency} className="font-semibold" /></span>
            </div>
          ))}
          <p className="text-right text-xs text-foreground-muted">
            Every page of what is filtered, each currency apart. A payroll month not paid yet is listed, not counted.
          </p>
        </div>
      )}

      <LedgerDialog row={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

function Fact({ f }: { f: LedgerFact }) {
  // A line of text on its own (HRMS's notes on an advance).
  if (f.minor === undefined && f.text === undefined) return <p className="py-1 text-sm">{f.label}</p>;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <span className="text-foreground-muted">{f.label}</span>
      <span className="text-right">
        {f.minor !== undefined ? (
          <MoneyDisplay minor={f.minor} currency={f.currency ?? "AED"} className={f.minor < 0 ? "text-danger" : ""} />
        ) : (
          f.text || "—"
        )}
      </span>
    </div>
  );
}

/** One row, opened: what it is, its figures, and the way to the document itself. */
function LedgerDialog({ row, onClose }: { row: LedgerRow | null; onClose: () => void }) {
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {row && (
          <>
            <DialogHeader>
              <DialogTitle>
                {KIND_LABEL[row.kind]}{row.reference ? ` · ${row.reference}` : ""}
              </DialogTitle>
              <DialogDescription>
                {row.title}{row.subtitle ? ` — ${row.subtitle}` : ""} · {day(row.date)}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Badge tone={statusOf(row).tone}>{statusOf(row).text}</Badge>
              {row.inMinor > 0 && <span className="text-sm">Brought in <MoneyDisplay minor={row.inMinor} currency={row.currency} className="font-semibold text-success" /></span>}
              {row.outMinor > 0 && <span className="text-sm">Paid / spent <MoneyDisplay minor={row.outMinor} currency={row.currency} className="font-semibold" /></span>}
            </div>
            <div className="divide-y divide-border rounded-lg border border-border px-3">
              {row.facts.map((f) => <Fact key={f.label} f={f} />)}
            </div>
            {row.sections.map((s) => (
              <div key={s.title} className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">{s.title}</p>
                <div className="divide-y divide-border rounded-lg border border-border px-3">
                  {s.items.map((f, i) => <Fact key={`${s.title}-${i}`} f={f} />)}
                </div>
              </div>
            ))}
            {row.href && (
              <Link href={row.href} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                <ExternalLink className="h-3.5 w-3.5" />{OPEN_LABEL[row.kind]}
              </Link>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
