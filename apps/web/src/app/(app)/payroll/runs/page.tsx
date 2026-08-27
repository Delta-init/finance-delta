"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Wallet, Download, AlertTriangle, Info, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MoneyDisplay } from "@/components/ui/money";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { useAvailableBatches, useImportPreview, useImportRun, usePayrollRuns } from "@/features/payroll/api";
import { RUN_STATUS_LABELS, type AvailableBatch, type RunStatus, type RunSummary } from "@/features/payroll/types";

const TONE: Record<RunStatus, "success" | "warning" | "neutral" | "danger" | "primary"> = {
  imported: "primary",
  additions: "primary",
  approved: "warning",
  partially_paid: "warning",
  paid: "success",
  returned: "danger",
  voided: "neutral",
};

export default function PayrollRunsPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [candidate, setCandidate] = useState<AvailableBatch | null>(null);

  const runs = usePayrollRuns({ page, limit: pageSize });
  const available = useAvailableBatches();
  const preview = useImportPreview(candidate?.hrmsOrgId ?? null, candidate?.period ?? null);
  const doImport = useImportRun();

  const waiting = (available.data ?? []).filter((b) => !b.imported && b.status === "submitted");

  const columns: Column<RunSummary>[] = [
    { key: "runNumber", header: "Run", cell: (r) => <span className="font-medium">{r.runNumber}</span> },
    { key: "period", header: "Month", cell: (r) => r.period },
    { key: "org", header: "From", cell: (r) => <span className="text-foreground-muted">{r.hrmsOrgName}</span> },
    {
      key: "payable", header: "Payable", align: "right",
      cell: (r) => <MoneyDisplay minor={r.payableMinor} currency={r.currency} />,
    },
    {
      key: "balance", header: "Outstanding", align: "right",
      cell: (r) => <MoneyDisplay minor={r.balanceMinor} currency={r.currency} />,
    },
    { key: "status", header: "Status", cell: (r) => <Badge tone={TONE[r.status]}>{RUN_STATUS_LABELS[r.status]}</Badge> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Wallet}
        title="Payroll runs"
        description="Months handed over by HR, imported here to be adjusted and paid."
      />

      {/* ── Waiting to be imported ───────────────────────────────────────── */}
      {waiting.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Waiting from HR</CardTitle>
            <CardDescription>
              These months have been submitted and are not yet in this book.
            </CardDescription>
          </CardHeader>
          <div className="divide-y divide-border">
            {waiting.map((b) => (
              <div key={`${b.hrmsOrgId}:${b.period}`} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{b.period} · {b.hrmsOrgName}</div>
                  <div className="text-xs text-foreground-muted">
                    {b.employeeCount} people · {b.currency} {b.netTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })} net
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setCandidate(b)}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />Review &amp; import
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {available.isError && (
        <Card>
          <p className="px-5 py-4 text-sm text-danger">
            Could not reach HRMS: {(available.error as Error).message}
          </p>
        </Card>
      )}

      <Card className="overflow-hidden">
        <DataTable
          columns={columns}
          data={runs.data?.data}
          getRowId={(r) => r.id}
          total={runs.data?.meta.total ?? 0}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          onRowClick={(r) => router.push(`/payroll/runs/${r.id}`)}
          isLoading={runs.isLoading}
          emptyMessage="No payroll has been imported yet."
        />
      </Card>

      {/* ── Import review ────────────────────────────────────────────────── */}
      <Dialog open={Boolean(candidate)} onOpenChange={(o) => { if (!o) { setCandidate(null); doImport.reset(); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import {candidate?.period} from {candidate?.hrmsOrgName}?</DialogTitle>
            <DialogDescription>
              The figures are checked against HRMS before anything is written. Importing tells HR that
              accounts have the month, and locks it on their side.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            {preview.isLoading && <p className="text-foreground-muted">Checking with HRMS…</p>}
            {preview.isError && <p className="text-danger">{(preview.error as Error).message}</p>}

            {preview.data && (
              <>
                <div className="rounded-lg border border-border bg-surface-muted p-3">
                  <Row label="People" value={String(preview.data.totals.employeeCount)} />
                  <Row
                    label="Net to pay"
                    value={<MoneyDisplay minor={preview.data.totals.netMinor} currency={preview.data.currency} />}
                    strong
                  />
                </div>

                {preview.data.blockers.map((b) => (
                  <p key={b} className="flex items-start gap-2 text-danger">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{b}</span>
                  </p>
                ))}
                {preview.data.warnings.map((w) => (
                  <p key={w} className="flex items-start gap-2 text-warning">
                    <Info className="mt-0.5 h-4 w-4 shrink-0" /><span>{w}</span>
                  </p>
                ))}

                {preview.data.unmapped.length > 0 && (
                  <div className="rounded-lg border border-danger/20 bg-danger/5 p-3">
                    <p className="font-medium text-danger">Not mapped in finance</p>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {preview.data.unmapped.slice(0, 8).map((u) => (
                        <li key={u.hrmsEmployeeId}>{u.employeeCode} · {u.name}</li>
                      ))}
                      {preview.data.unmapped.length > 8 && (
                        <li className="text-foreground-muted">…and {preview.data.unmapped.length - 8} more</li>
                      )}
                    </ul>
                  </div>
                )}

                {preview.data.canImport && preview.data.warnings.length === 0 && (
                  <p className="flex items-start gap-2 text-success">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Everything checks out.</span>
                  </p>
                )}
              </>
            )}

            {doImport.isError && <p className="text-danger">{(doImport.error as Error).message}</p>}
            {doImport.data && (
              <div className="rounded-lg border border-success/20 bg-success/5 p-3">
                <p className="font-medium text-success">
                  Imported as {doImport.data.runNumber} — {doImport.data.employeeCount} people,{" "}
                  {doImport.data.netFormatted}.
                </p>
                {doImport.data.warnings.map((w) => (
                  <p key={w} className="mt-1 text-xs text-warning">{w}</p>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="secondary" onClick={() => { setCandidate(null); doImport.reset(); }}>
              {doImport.data ? "Close" : "Cancel"}
            </Button>
            {!doImport.data && (
              <Button
                loading={doImport.isPending}
                disabled={!preview.data?.canImport}
                onClick={() =>
                  candidate && doImport.mutate({ hrmsOrgId: candidate.hrmsOrgId, period: candidate.period })
                }
              >
                Import
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-foreground-muted">{label}</span>
      <span className={strong ? "font-semibold" : "font-medium"}>{value}</span>
    </div>
  );
}
