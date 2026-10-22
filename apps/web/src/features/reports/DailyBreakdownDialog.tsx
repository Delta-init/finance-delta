"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import type { DailyBreakdown, DailyBreakdownKind } from "@delta/shared";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { useDailyBreakdown } from "./api";

/** What was clicked: a figure (or net) over a day or the report's range, with its department scope. */
export type DailyPick = { kind: DailyBreakdownKind | "net"; from: string; to: string; departmentId?: string; label: string };

const KIND_TITLE: Record<DailyBreakdownKind, string> = { income: "Income received", expense: "Expenses", revenue: "Revenue (invoiced)" };

/**
 * Where a Daily Report figure came from (the user, 2026-10-21: "when we click on stats we can see where it came
 * from"): its total grouped — by method, salesperson, CRM; or category, department, who, status — and every record
 * behind it, each opening its page. "Net" shows income and expenses side by side.
 */
export function DailyBreakdownDialog({ pick, onClose, money }: {
  pick: DailyPick | null;
  onClose: () => void;
  /** The page's own formatting (its display currency). */
  money: (minor: number) => string;
}) {
  const kinds: DailyBreakdownKind[] = !pick ? [] : pick.kind === "net" ? ["income", "expense"] : [pick.kind];
  return (
    <Dialog open={!!pick} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{pick ? (pick.kind === "net" ? "Net — income less expenses" : KIND_TITLE[pick.kind]) : ""}</DialogTitle>
          <DialogDescription>
            {pick?.label}
            {/* One day: everything on it, in one table (2026-10-22). */}
            {pick && pick.from === pick.to && (
              <>
                {" · "}
                <Link
                  href={`/reports/daily/${pick.from}${pick.departmentId ? `?department=${pick.departmentId}` : ""}`}
                  className="text-primary hover:underline"
                  onClick={onClose}
                >
                  Open the full day →
                </Link>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className={kinds.length > 1 ? "grid gap-6 lg:grid-cols-2" : ""}>
          {pick && kinds.map((k) => (
            <KindBreakdown key={k} kind={k} pick={pick} money={money} showTitle={kinds.length > 1} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function KindBreakdown({ kind, pick, money, showTitle }: { kind: DailyBreakdownKind; pick: DailyPick; money: (m: number) => string; showTitle: boolean }) {
  const { data, isLoading, error } = useDailyBreakdown({ kind, from: pick.from, to: pick.to, departmentId: pick.departmentId });
  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-foreground-muted" /></div>;
  if (error || !data) {
    return (
      <p className="py-10 text-center text-sm text-foreground-muted">
        {error instanceof ApiError && error.status === 404 ? "This needs the latest finance API — ask for it to be updated." : error instanceof ApiError ? error.message : "Could not load it."}
      </p>
    );
  }
  return <Breakdown data={data} money={money} title={showTitle ? KIND_TITLE[kind] : undefined} />;
}

function Breakdown({ data, money, title }: { data: DailyBreakdown; money: (m: number) => string; title?: string }) {
  const [groupKey, setGroupKey] = useState(data.groups[0]?.key ?? "");
  const group = data.groups.find((g) => g.key === groupKey) ?? data.groups[0];
  const [open, setOpen] = useState<string | null>(null);
  const shown = open && group ? data.records.filter((r) => (r.groups[group.key] ?? "—") === open) : data.records;
  const max = Math.max(1, ...(group?.items ?? []).map((i) => Math.abs(i.amountMinor)));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {title && <h3 className="text-sm font-semibold">{title}</h3>}
        <p className="text-sm text-foreground-muted">
          <span className="font-numeric text-lg font-semibold text-foreground">{money(data.totalMinor)}</span> · {data.count} record{data.count === 1 ? "" : "s"}
        </p>
      </div>

      {data.count === 0 ? (
        <p className="py-8 text-center text-sm text-foreground-muted">Nothing here.</p>
      ) : (
        <>
          {group && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1 text-xs">
                {data.groups.map((g) => (
                  <button
                    key={g.key}
                    onClick={() => { setGroupKey(g.key); setOpen(null); }}
                    className={`rounded-md px-2.5 py-1 font-medium ${g.key === group.key ? "bg-primary text-primary-foreground" : "bg-surface-muted text-foreground-muted hover:text-foreground"}`}
                  >
                    By {g.label.toLowerCase()}
                  </button>
                ))}
              </div>
              <ul className="space-y-1">
                {group.items.map((i) => (
                  <li key={i.name}>
                    <button
                      onClick={() => setOpen(open === i.name ? null : i.name)}
                      className={`w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-muted ${open === i.name ? "bg-surface-muted" : ""}`}
                      title="Show only these records"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate">{i.name} <span className="text-xs text-foreground-muted">· {i.count}</span></span>
                        <span className="shrink-0 font-numeric font-medium">{money(i.amountMinor)}</span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-surface-muted">
                        <div className="h-1.5 rounded-full bg-primary" style={{ width: `${(Math.abs(i.amountMinor) / max) * 100}%` }} />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-border">
            <div className="flex items-center justify-between bg-surface-muted px-3 py-2 text-xs font-medium text-foreground-muted">
              <span>{open ? `${open} — ${shown.length} record${shown.length === 1 ? "" : "s"}` : `Every record (${data.count})`}</span>
              {open && <button onClick={() => setOpen(null)} className="text-primary hover:underline">Show all</button>}
            </div>
            <ul className="max-h-[40vh] divide-y divide-border overflow-y-auto">
              {shown.map((r) => (
                <li key={r.id}>
                  <Link href={r.href} className="flex items-start justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-muted/60">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{r.number}{r.title ? ` · ${r.title}` : ""}</span>
                      <span className="block truncate text-xs text-foreground-muted">{r.date}{r.detail ? ` · ${r.detail}` : ""}</span>
                    </span>
                    <span className="shrink-0 font-numeric font-medium">{money(r.amountMinor)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
