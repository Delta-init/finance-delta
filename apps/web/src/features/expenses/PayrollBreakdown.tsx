"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { formatMoney, paymentMethodLabel } from "@delta/shared";
import { Users, Search, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ExportButton } from "@/components/ui/export-button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ExportColumn } from "@/lib/export";

export interface PayrollBreakdownRow {
  lineId: string; name: string; employeeCode: string; departmentName: string; designation: string;
  paidMinor: number; payableMinor: number; finished: boolean;
}
export interface PayrollBreakdown {
  runId: string; runNumber: string; period: string; paymentId: string; method: string; paidOn: string;
  bankAccountName: string; reference: string; currency: string; amountMinor: number;
  reversed: boolean; reversalReason: string; rows: PayrollBreakdownRow[];
}

/** Who the payroll payment that posted this expense paid, and how much each — payroll:read only (2026-11-04). */
export function usePayrollBreakdown(expenseId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["expenses", expenseId, "payroll-breakdown"],
    queryFn: () => api.get<PayrollBreakdown | null>(`expenses/${expenseId}/payroll-breakdown`),
    enabled: !!expenseId && enabled,
    retry: false,
  });
}

/**
 * The breakdown of a payroll expense (the user, 2026-11-04: "which employee and how much they were paid"): each person
 * this payment paid — what it paid them, their month's pay, and whether it finished it or paid part — adding up to
 * the expense; searchable, exportable, the run a click away.
 */
export function PayrollBreakdownTable({ data }: { data: PayrollBreakdown }) {
  const [q, setQ] = useState("");
  const m = (minor: number) => formatMoney(minor, data.currency);
  const needle = q.trim().toLowerCase();
  const rows = data.rows.filter((r) => !needle || [r.name, r.employeeCode, r.departmentName, r.designation].some((x) => x.toLowerCase().includes(needle)));
  const total = rows.reduce((a, r) => a + r.paidMinor, 0);
  const columns: ExportColumn<PayrollBreakdownRow>[] = [
    { header: "Employee", value: (r) => r.name },
    { header: "Code", value: (r) => r.employeeCode },
    { header: "Department", value: (r) => r.departmentName },
    { header: "Designation", value: (r) => r.designation },
    { header: `Paid in ${data.paymentId}`, value: (r) => r.paidMinor / 100 },
    { header: "Month's pay", value: (r) => r.payableMinor / 100 },
    { header: "Paid", value: (r) => (r.finished ? "In full" : "Part") },
    { header: "Currency", value: () => data.currency },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-muted">
        <Link href={`/payroll/runs/${data.runId}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
          {data.paymentId} <ExternalLink className="h-3 w-3" />
        </Link>
        <span>{data.period}</span>
        <span>{paymentMethodLabel(data.method)}{data.bankAccountName ? ` · ${data.bankAccountName}` : ""}</span>
        <span>paid {data.paidOn}</span>
        {data.reference && <span>ref {data.reference}</span>}
        {data.reversed && <Badge tone="danger">Reversed{data.reversalReason ? ` — ${data.reversalReason}` : ""}</Badge>}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code or department…" className="pl-8" />
        </div>
        <ExportButton
          resource="expenses"
          fetchRows={async () => rows}
          columns={columns}
          filename={`${data.paymentId}-breakdown`}
          title={`${data.runNumber} ${data.paymentId} — who was paid`}
        />
      </div>
      <div className="max-h-[50vh] overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-muted text-xs text-foreground-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Employee</th>
              <th className="px-3 py-2 text-left font-medium">Department</th>
              <th className="px-3 py-2 text-right font-medium">Paid in this payment</th>
              <th className="px-3 py-2 text-right font-medium">Month&apos;s pay</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.lineId} className="border-t border-border">
                <td className="px-3 py-2">
                  <p className="font-medium">{r.name}</p>
                  <p className="text-xs text-foreground-muted">{[r.employeeCode, r.designation].filter(Boolean).join(" · ")}</p>
                </td>
                <td className="px-3 py-2 text-foreground-muted">{r.departmentName || "—"}</td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {m(r.paidMinor)}
                  {!r.finished && <span className="ml-1.5 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">part</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-foreground-muted">{m(r.payableMinor)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-4 text-center text-foreground-muted">Nobody matches.</td></tr>
            )}
          </tbody>
          <tfoot className="border-t-2 border-border bg-surface-muted font-semibold">
            <tr>
              <td className="px-3 py-2" colSpan={2}>
                {needle ? `${rows.length} of ${data.rows.length} people` : `${data.rows.length} ${data.rows.length === 1 ? "person" : "people"}`}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{m(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** The card on a payroll expense's page. */
export function PayrollBreakdownCard({ expenseId }: { expenseId: string }) {
  const { data, isLoading } = usePayrollBreakdown(expenseId);
  if (isLoading || !data) return null;
  return (
    <div className="rounded-lg border border-border bg-surface p-5 space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4" /> Payroll breakdown</h2>
      <PayrollBreakdownTable data={data} />
    </div>
  );
}

/** The same, in a pop-up — from "N people" on the Expenses list. */
export function PayrollBreakdownDialog({ expenseId, title, onClose }: { expenseId: string; title: string; onClose: () => void }) {
  const { data, isLoading, error } = usePayrollBreakdown(expenseId);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{title} — who was paid</DialogTitle></DialogHeader>
        {isLoading ? (
          <p className="py-6 text-center text-sm text-foreground-muted">Loading…</p>
        ) : data ? (
          <PayrollBreakdownTable data={data} />
        ) : (
          <p className="py-6 text-center text-sm text-foreground-muted">{error ? "Could not load the breakdown." : "No payroll payment posted this expense."}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
