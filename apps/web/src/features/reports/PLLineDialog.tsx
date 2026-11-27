"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ExportButton } from "@/components/ui/export-button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { Breakdown } from "./DailyBreakdownDialog";

/*
 * The records behind one Profit & Loss line (the user, 2026-11-27: "each line will be break down also popup"), counted by
 * the P&L's own rules so they add up to the line clicked: each invoice or payment behind the income, each bill or bill
 * payment, each expense of a category. Grouped (click a group to see only its records), searchable, exportable.
 */

export type PLLinePick = { line: string; label: string; from: string; to: string; basis: "invoiced" | "collected" };

type Row = {
  id: string; date: string; number: string; title: string; detail: string; amountMinor: number; currency: string; href: string; kind: string;
  grossMinor?: number; vatMinor?: number; crm?: string; salesperson?: string; category?: string; subcategory?: string; department?: string; method?: string; employee?: string; month: string;
};

const GROUPS: { key: keyof Row; label: string; income?: boolean }[] = [
  { key: "category", label: "Category" }, { key: "subcategory", label: "Subcategory" }, { key: "department", label: "Department" },
  { key: "crm", label: "CRM", income: true }, { key: "salesperson", label: "Salesperson", income: true },
  { key: "method", label: "Payment method" }, { key: "month", label: "Month" },
];

function Lines({ pick, money }: { pick: PLLinePick; money: (m: number) => string }) {
  const [text, setText] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "profit-loss", "lines", pick.line, pick.from, pick.to, pick.basis],
    queryFn: () => api.get<{ currency: string; rows: Row[]; totalMinor: number }>(`reports/profit-loss/lines?from=${pick.from}&to=${pick.to}&basis=${pick.basis}&line=${encodeURIComponent(pick.line)}`),
  });
  const income = pick.line === "income";
  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => !needle || `${r.number} ${r.title} ${r.detail} ${r.employee ?? ""}`.toLowerCase().includes(needle));
  }, [data, text]);
  const breakdown = useMemo(() => {
    const groups = GROUPS.filter((g) => (income ? g.income || g.key === "method" || g.key === "month" : !g.income)).map((g) => {
      const by = new Map<string, { name: string; count: number; amountMinor: number }>();
      for (const r of shown) {
        const name = String(r[g.key] ?? "") || "—";
        const t = by.get(name) ?? { name, count: 0, amountMinor: 0 };
        t.count++; t.amountMinor += r.amountMinor; by.set(name, t);
      }
      const items = [...by.values()].sort((a, b) => (g.key === "month" ? b.name.localeCompare(a.name) : b.amountMinor - a.amountMinor));
      return { key: String(g.key), label: g.label, items };
    }).filter((g) => g.items.length > 1 || (g.items[0] && g.items[0].name !== "—"));
    return {
      totalMinor: shown.reduce((n, r) => n + r.amountMinor, 0), count: shown.length, groups,
      records: shown.map((r) => ({
        id: r.id, date: r.date, number: r.number, title: r.title, currency: r.currency, href: r.href, amountMinor: r.amountMinor,
        detail: [r.detail, r.vatMinor ? `VAT ${money(r.vatMinor)} out` : "", r.employee].filter(Boolean).join(" · "),
        groups: Object.fromEntries(groups.map((g) => [g.key, String(r[g.key as keyof Row] ?? "") || "—"])),
      })),
    };
  }, [shown, income, money]);

  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></div>;
  if (error || !data) {
    return <p className="py-10 text-center text-sm text-foreground-muted">{error instanceof ApiError && error.status === 404 ? "This needs the latest finance API — ask for it to be updated." : error instanceof ApiError ? error.message : "Could not load it."}</p>;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search number, name or detail" className="h-8 pl-8 text-sm" />
        </div>
        <div className="sm:ml-auto">
          <ExportButton<Row>
            resource="" filename={`profit-loss-${pick.label.replace(/\W+/g, "-").toLowerCase()}-${pick.from}_${pick.to}`} title={`${pick.label}, ${pick.from} to ${pick.to}`}
            formats={["excel", "csv"]} fetchRows={async () => shown}
            columns={[
              { header: "Date", value: (r) => r.date }, { header: "Number", value: (r) => r.number }, { header: income ? "Client" : "Description", value: (r) => r.title },
              ...(income ? [{ header: "CRM", value: (r: Row) => r.crm ?? "" }, { header: "Salesperson", value: (r: Row) => r.salesperson ?? "" }] : [{ header: "Category", value: (r: Row) => r.category ?? "" }, { header: "Subcategory", value: (r: Row) => r.subcategory ?? "" }, { header: "Department", value: (r: Row) => r.department ?? "" }]),
              { header: "Payment method", value: (r) => r.method ?? "" }, { header: "Detail", value: (r) => r.detail },
              ...(r0VAT(data.rows) ? [{ header: "With VAT", value: (r: Row) => (r.grossMinor ?? 0) / 100 }, { header: "VAT", value: (r: Row) => (r.vatMinor ?? 0) / 100 }] : []),
              { header: `Counted (${data.currency})`, value: (r) => r.amountMinor / 100 },
            ]}
          />
        </div>
      </div>
      <Breakdown data={breakdown} money={money} />
    </div>
  );
}

const r0VAT = (rows: Row[]) => rows.some((r) => r.vatMinor !== undefined);

export function PLLineDialog({ pick, onClose, money }: { pick: PLLinePick | null; onClose: () => void; money: (m: number) => string }) {
  return (
    <Dialog open={!!pick} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{pick?.label}</DialogTitle>
          <DialogDescription>
            {pick && `${pick.from} → ${pick.to} · ${pick.basis === "collected" ? "money received and paid in the period" : "invoices issued and expenses dated in the period"}. The total is the line's.`}
          </DialogDescription>
        </DialogHeader>
        {pick && <Lines key={`${pick.line}:${pick.basis}:${pick.from}:${pick.to}`} pick={pick} money={money} />}
      </DialogContent>
    </Dialog>
  );
}
