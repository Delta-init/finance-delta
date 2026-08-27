"use client";

import { Fragment, use, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Wallet, PauseCircle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MoneyDisplay } from "@/components/ui/money";
import { usePayrollRun } from "@/features/payroll/api";
import { RUN_STATUS_LABELS, type LineStatus, type RunStatus } from "@/features/payroll/types";

const RUN_TONE: Record<RunStatus, "success" | "warning" | "neutral" | "danger" | "primary"> = {
  imported: "primary", additions: "primary", approved: "warning",
  partially_paid: "warning", paid: "success", returned: "danger", voided: "neutral",
};

const LINE_TONE: Record<LineStatus, "success" | "warning" | "neutral" | "danger"> = {
  pending: "neutral", on_hold: "danger", partially_paid: "warning", paid: "success",
};

const LINE_LABEL: Record<LineStatus, string> = {
  pending: "To pay", on_hold: "Held", partially_paid: "Part paid", paid: "Paid",
};

export default function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: run, isLoading } = usePayrollRun(id);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const lines = useMemo(() => {
    if (!run) return [];
    const q = search.trim().toLowerCase();
    if (!q) return run.lines;
    return run.lines.filter(
      (l) => l.name.toLowerCase().includes(q) || l.employeeCode.toLowerCase().includes(q),
    );
  }, [run, search]);

  if (isLoading) return <p className="text-sm text-foreground-muted">Loading…</p>;
  if (!run) return <p className="text-sm text-danger">Payroll run not found.</p>;

  return (
    <div className="space-y-6">
      <Link href="/payroll/runs" className="inline-flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />All payroll runs
      </Link>

      <PageHeader
        icon={Wallet}
        title={`${run.runNumber} · ${run.period}`}
        description={`From ${run.hrmsOrgName}. Imported ${run.importedAt ? new Date(run.importedAt).toLocaleDateString() : ""}${run.importedByName ? ` by ${run.importedByName}` : ""}.`}
        action={<Badge tone={RUN_TONE[run.status]}>{RUN_STATUS_LABELS[run.status]}</Badge>}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="People" value={String(run.totals.employeeCount)} />
        <Stat label="Gross" value={<MoneyDisplay minor={run.totals.hrmsGrossMinor} currency={run.currency} />} />
        <Stat label="Deductions" value={<MoneyDisplay minor={run.totals.hrmsDeductionsMinor} currency={run.currency} />} />
        <Stat label="Payable" value={<MoneyDisplay minor={run.totals.payableMinor} currency={run.currency} />} strong />
        <Stat label="Outstanding" value={<MoneyDisplay minor={run.totals.balanceMinor} currency={run.currency} />} />
      </div>

      {run.totals.heldCount > 0 && (
        <Card className="flex items-start gap-2 border-danger/20 bg-danger/5 p-4 text-sm">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <p>
            <span className="font-medium text-danger">{run.totals.heldCount} person(s) are held</span> — there
            is nowhere to send their money. They are excluded from payment until HR adds bank details and the
            month is re-synced, so they cannot be swept into a bulk transfer and counted as paid.
          </p>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <Input
            placeholder="Search name or code"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:w-64"
          />
          <span className="ml-auto text-xs text-foreground-muted">{lines.length} of {run.lines.length}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
              <tr>
                <th className="px-5 py-3 font-medium">Employee</th>
                <th className="px-5 py-3 font-medium">Department</th>
                <th className="px-5 py-3 text-right font-medium">Gross</th>
                <th className="px-5 py-3 text-right font-medium">Deductions</th>
                <th className="px-5 py-3 text-right font-medium">Payable</th>
                <th className="px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                // Fragment, not <>, because the key has to live on the element
                // that is actually the list child — the shorthand cannot take one.
                <Fragment key={l.id}>
                  <tr
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-muted"
                    onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium">{l.name}</div>
                      <div className="text-xs text-foreground-muted">
                        {l.employeeCode}{l.designation ? ` · ${l.designation}` : ""}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-foreground-muted">{l.departmentName || "—"}</td>
                    <td className="px-5 py-3 text-right"><MoneyDisplay minor={l.grossMinor} currency={run.currency} /></td>
                    <td className="px-5 py-3 text-right"><MoneyDisplay minor={l.deductionsMinor} currency={run.currency} /></td>
                    <td className="px-5 py-3 text-right font-medium"><MoneyDisplay minor={l.payableMinor} currency={run.currency} /></td>
                    <td className="px-5 py-3">
                      <Badge tone={LINE_TONE[l.status]}>{LINE_LABEL[l.status]}</Badge>
                      {l.holdReason && <div className="mt-1 text-xs text-danger">{l.holdReason}</div>}
                    </td>
                  </tr>
                  {expanded === l.id && (
                    <tr className="border-b border-border bg-surface-muted/50">
                      <td colSpan={6} className="px-5 py-4">
                        <div className="grid gap-6 sm:grid-cols-2">
                          <Breakdown title="Earnings" items={l.earnings} currency={run.currency} />
                          <Breakdown title="Deductions" items={l.deductions} currency={run.currency} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {lines.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-10 text-center text-foreground-muted">Nothing matches that search.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <Card className="p-4">
      <div className={strong ? "text-lg font-semibold" : "text-lg"}>{value}</div>
      <div className="mt-0.5 text-xs text-foreground-muted">{label}</div>
    </Card>
  );
}

function Breakdown({
  title, items, currency,
}: { title: string; items: Array<{ label: string; amountMinor: number }>; currency: string }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-foreground-muted">{title}</p>
      {items.length === 0 ? (
        <p className="text-sm text-foreground-muted">None</p>
      ) : (
        <ul className="space-y-1">
          {items.map((i, idx) => (
            <li key={`${i.label}-${idx}`} className="flex justify-between text-sm">
              <span>{i.label}</span>
              <MoneyDisplay minor={i.amountMinor} currency={currency} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
