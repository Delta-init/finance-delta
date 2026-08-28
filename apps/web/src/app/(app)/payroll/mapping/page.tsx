"use client";

import { useEffect, useMemo, useState } from "react";
import { Link2, RefreshCw, ShieldAlert, CheckCircle2, XCircle, Unlink } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAllDepartments } from "@/features/departments/api";
import { useUsers } from "@/features/users/api";
import {
  useApplySync, useCreateOrgLink, useHrmsOrganizations, useIntegrationHealth,
  useOrgLinks, useRemoveOrgLink, useSyncPreview,
} from "@/features/payroll-mapping/api";
import { DepartmentReview } from "@/features/payroll-mapping/department-review";
import { EmployeeReview, BulkActions } from "@/features/payroll-mapping/employee-review";
import type { ApplyResult, EmpRow, SyncDecision, SyncPreview } from "@/features/payroll-mapping/types";

const dkey = (d: { kind: string; hrmsId: string }) => `${d.kind}:${d.hrmsId}`;

/**
 * Builds the opening position from a fresh preview.
 *
 * Everything the server was confident about is pre-selected, because a screen
 * that makes somebody click sixty times gets clicked sixty times without being
 * read. The exception is a conflict: those open as "leave alone", so accepting
 * one is a deliberate act rather than the default that survives a scroll.
 */
function seedDecisions(preview: SyncPreview): Record<string, SyncDecision> {
  const out: Record<string, SyncDecision> = {};
  for (const d of preview.departments) {
    const base = { kind: "department" as const, hrmsId: d.hrmsDepartmentId };
    if (d.state === "proposed") out[dkey(base)] = { ...base, action: "link", targetDepartmentId: d.departmentId ?? undefined };
    else if (d.state === "unmatched") out[dkey(base)] = { ...base, action: "create" };
    else out[dkey(base)] = { ...base, action: "skip" };
  }
  for (const e of preview.employees) {
    const base = { kind: "employee" as const, hrmsId: e.hrmsEmployeeId };
    if (e.state === "proposed") out[dkey(base)] = { ...base, action: "link", targetUserId: e.userId ?? undefined };
    else if (e.state === "new") out[dkey(base)] = { ...base, action: "create" };
    // Somebody already mapped whose details still match needs nothing doing.
    // Defaulting them to "link" meant a fully synced organization still offered
    // to "import 3 people", which reads as though the mapping had not worked.
    else if (e.state === "linked") {
      out[dkey(base)] = e.changes.length > 0
        ? { ...base, action: "link", targetUserId: e.userId ?? undefined }
        : { ...base, action: "skip" };
    }
    else out[dkey(base)] = { ...base, action: "skip" };
  }
  return out;
}

export default function PayrollMappingPage() {
  const health = useIntegrationHealth();
  const orgLinks = useOrgLinks();
  const hrmsOrgs = useHrmsOrganizations(Boolean(health.data?.reachable));
  const departments = useAllDepartments();
  const users = useUsers({ page: 1, pageSize: 200 });

  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, SyncDecision>>({});
  const [applied, setApplied] = useState<ApplyResult | null>(null);

  const preview = useSyncPreview(selectedOrg);
  const createLink = useCreateOrgLink();
  const removeLink = useRemoveOrgLink();
  const apply = useApplySync();

  // Re-seed whenever a new proposal arrives, so decisions can never be carried
  // over from a preview that described a different roster.
  useEffect(() => {
    if (preview.data) {
      setDecisions(seedDecisions(preview.data));
      setApplied(null);
    }
  }, [preview.data]);

  const setDecision = (kind: "department" | "employee") => (hrmsId: string, next: SyncDecision) =>
    setDecisions((prev) => ({ ...prev, [dkey({ kind, hrmsId })]: next }));

  function bulk(states: EmpRow["state"][], action: SyncDecision["action"]) {
    if (!preview.data) return;
    setDecisions((prev) => {
      const next = { ...prev };
      for (const e of preview.data!.employees) {
        // Conflicts are never swept up by a bulk action, whatever it is.
        if (e.state === "conflict" && action !== "skip") continue;
        if (!states.includes(e.state)) continue;
        const base = { kind: "employee" as const, hrmsId: e.hrmsEmployeeId };
        next[dkey(base)] = { ...base, action, targetUserId: action === "link" ? e.userId ?? undefined : undefined };
      }
      return next;
    });
  }

  // What Apply will actually do, counted from the decisions rather than from
  // the preview — the two diverge the moment anybody changes a row.
  const pending = useMemo(() => {
    const list = Object.values(decisions).filter((d) => d.action !== "skip");
    const alreadyMapped = new Set(
      (preview.data?.employees ?? []).filter((e) => e.state === "linked").map((e) => e.hrmsEmployeeId),
    );
    const employees = list.filter((d) => d.kind === "employee");
    return {
      list,
      deptCreate: list.filter((d) => d.kind === "department" && d.action === "create").length,
      deptLink: list.filter((d) => d.kind === "department" && d.action === "link").length,
      // An existing row being brought up to date is a refresh, not an import;
      // calling both "import" made a re-sync look like it was duplicating people.
      empImport: employees.filter((d) => d.action !== "deactivate" && !alreadyMapped.has(d.hrmsId)).length,
      empRefresh: employees.filter((d) => d.action !== "deactivate" && alreadyMapped.has(d.hrmsId)).length,
      empWithLogin: employees.filter((d) => d.action === "link" && d.targetUserId).length,
      empDeactivate: employees.filter((d) => d.action === "deactivate").length,
    };
  }, [decisions, preview.data]);

  // A "link" that never got a target would silently become a plain import.
  const incompleteDepartments = pending.list.filter(
    (d) => d.kind === "department" && d.action === "link" && !d.targetDepartmentId,
  ).length;

  function runApply() {
    if (!selectedOrg) return;
    apply.mutate(
      { hrmsOrgId: selectedOrg, decisions: pending.list },
      {
        onSuccess: (res) => {
          setApplied(res);
          void preview.refetch();
        },
      },
    );
  }

  const linkableOrgs = (hrmsOrgs.data ?? []).filter((o) => !o.linked);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Link2}
        title="Payroll mapping"
        description="Connect HRMS organizations, departments and people to this book, before any payroll is imported."
      />

      {/* ── Connection ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>HRMS connection</CardTitle>
            <CardDescription>
              {health.isLoading
                ? "Checking…"
                : !health.data?.configured
                  ? "Not configured on this server. Set HRMS_API_URL, HRMS_CLIENT_ID and HRMS_INTEGRATION_SECRET."
                  : health.data.reachable
                    ? "Credentials accepted and clocks agree."
                    : (health.data.message ?? "HRMS did not answer.")}
            </CardDescription>
          </div>
          {health.data && (
            <Badge tone={health.data.reachable ? "success" : "danger"}>
              {health.data.reachable ? (
                <><CheckCircle2 className="mr-1 inline h-3 w-3" />Connected</>
              ) : (
                <><XCircle className="mr-1 inline h-3 w-3" />Not connected</>
              )}
            </Badge>
          )}
        </CardHeader>
      </Card>

      {/* ── Organization links ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Linked organizations</CardTitle>
          <CardDescription>
            Each HRMS organization pays out of exactly one finance book. Several may point here.
          </CardDescription>
        </CardHeader>
        <div className="divide-y divide-border">
          {(orgLinks.data ?? []).map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{l.hrmsOrgName}</div>
                <div className="text-xs text-foreground-muted">
                  {l.hrmsOrgCode} · {l.hrmsCurrency}
                  {l.lastSyncedAt ? ` · last synced ${new Date(l.lastSyncedAt).toLocaleString()}` : " · never synced"}
                </div>
              </div>
              <Button
                size="sm"
                variant={selectedOrg === l.hrmsOrgId ? "primary" : "secondary"}
                onClick={() => setSelectedOrg(l.hrmsOrgId)}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Review
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => removeLink.mutate(l.id)}
                title="Unlink this organization"
                aria-label={`Unlink ${l.hrmsOrgName}`}
              >
                <Unlink className="mr-1.5 h-3.5 w-3.5" />Unlink
              </Button>
            </div>
          ))}
          {orgLinks.data?.length === 0 && (
            <p className="px-5 py-6 text-sm text-foreground-muted">Nothing linked yet.</p>
          )}
        </div>

        {health.data?.reachable && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
            <span className="text-sm text-foreground-muted">Add an organization</span>
            <Select
              value=""
              onValueChange={(v) => createLink.mutate(v)}
            >
              <SelectTrigger className="w-[280px]">
                <SelectValue placeholder={linkableOrgs.length ? "Link an HRMS organization…" : "Nothing left to link"} />
              </SelectTrigger>
              <SelectContent>
                {linkableOrgs.map((o) => (
                  <SelectItem key={o.id} value={o.id}>{o.name} ({o.currency})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {createLink.data?.currencyMismatch && (
              <span className="flex items-center gap-1.5 text-xs text-warning">
                <ShieldAlert className="h-3.5 w-3.5" />
                {createLink.data.hrmsOrgName} runs payroll in {createLink.data.currencyMismatch.hrms} but this book is{" "}
                {createLink.data.currencyMismatch.finance}. Payroll will need an exchange rate.
              </span>
            )}
          </div>
        )}
      </Card>

      {/* ── Review ─────────────────────────────────────────────────────── */}
      {selectedOrg && (
        <>
          {preview.isLoading && (
            <Card><p className="px-5 py-8 text-sm text-foreground-muted">Comparing against HRMS…</p></Card>
          )}
          {preview.isError && (
            <Card>
              <p className="px-5 py-8 text-sm text-danger">
                {(preview.error as Error).message}
              </p>
            </Card>
          )}

          {preview.data && (
            <>
              {/* "Already mapped" always shows, because zero of it is the
                  headline on a first sync. The rest appear only when there is
                  something to report — six tiles of mostly zeroes told nobody
                  anything and buried the one number that mattered. */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                <Stat label="Already mapped" value={preview.data.summary.employees.linked} />
                {preview.data.summary.employees.new > 0 && (
                  <Stat label="New" value={preview.data.summary.employees.new} />
                )}
                {preview.data.summary.employees.proposed > 0 && (
                  <Stat label="Match found" value={preview.data.summary.employees.proposed} />
                )}
                {preview.data.summary.employees.orphaned > 0 && (
                  <Stat label="Gone from HRMS" value={preview.data.summary.employees.orphaned} tone="warning" />
                )}
                {preview.data.summary.employees.conflict > 0 && (
                  <Stat label="Needs a decision" value={preview.data.summary.employees.conflict} tone="danger" />
                )}
                {preview.data.summary.blockers.noBankDetails > 0 && (
                  <Stat label="No bank details" value={preview.data.summary.blockers.noBankDetails} tone="warning" />
                )}
                {preview.data.summary.blockers.unmappedDepartment > 0 && (
                  <Stat label="Dept. unmapped" value={preview.data.summary.blockers.unmappedDepartment} tone="warning" />
                )}
              </div>

              <DepartmentReview
                rows={preview.data.departments}
                decisions={decisions}
                onChange={setDecision("department")}
                financeDepartments={(departments.data ?? []).map((d) => ({ id: d.id, name: d.name }))}
              />

              <div className="space-y-3">
                <BulkActions rows={preview.data.employees} onBulk={bulk} />
                <EmployeeReview
                  rows={preview.data.employees}
                  decisions={decisions}
                  onChange={setDecision("employee")}
                  users={(users.data?.data ?? []).map((u) => ({ id: u.id, name: u.name, email: u.email }))}
                />
              </div>

              {/* ── Apply ─────────────────────────────────────────────── */}
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-4 p-5">
                  <div className="text-sm">
                    <div className="font-medium">
                      {pending.list.length === 0 ? "Everything is up to date" : "About to apply"}
                    </div>
                    <p className="mt-0.5 text-foreground-muted">
                      {pending.list.length === 0
                        ? "Nothing here differs from HRMS. Change an action on a row if you want to force something through."
                        : [
                            pending.deptCreate && `create ${pending.deptCreate} department(s)`,
                            pending.deptLink && `map ${pending.deptLink} department(s)`,
                            pending.empImport && `import ${pending.empImport} person(s)`,
                            pending.empRefresh && `refresh ${pending.empRefresh} already mapped`,
                            pending.empWithLogin && `${pending.empWithLogin} with a finance login`,
                            pending.empDeactivate && `deactivate ${pending.empDeactivate}`,
                          ].filter(Boolean).join(" · ")}
                    </p>
                    {incompleteDepartments > 0 && (
                      <p className="mt-1 flex items-center gap-1.5 text-warning">
                        <ShieldAlert className="h-3.5 w-3.5" />
                        {incompleteDepartments} department(s) set to map but with no target chosen.
                      </p>
                    )}
                  </div>
                  <Button
                    onClick={runApply}
                    loading={apply.isPending}
                    disabled={pending.list.length === 0 || incompleteDepartments > 0}
                  >
                    {pending.list.length === 0
                      ? "Nothing to apply"
                      : `Apply ${pending.list.length} change${pending.list.length === 1 ? "" : "s"}`}
                  </Button>
                </div>

                {applied && (
                  <div className="border-t border-border px-5 py-4 text-sm">
                    <p className="font-medium text-success">
                      Applied — {applied.employeesCreated} imported, {applied.employeesLinked} updated,{" "}
                      {applied.employeesDeactivated} deactivated, {applied.departmentsCreated + applied.departmentsLinked} department(s) mapped.
                    </p>
                    {applied.errors.length > 0 && (
                      <div className="mt-2">
                        <p className="font-medium text-danger">
                          {applied.errors.length} row(s) failed and were left untouched:
                        </p>
                        <ul className="mt-1 space-y-0.5 text-xs text-danger">
                          {applied.errors.map((e) => (
                            <li key={e.hrmsId}>{e.hrmsId}: {e.message}</li>
                          ))}
                        </ul>
                        <p className="mt-1 text-xs text-foreground-muted">
                          Everything else was applied. Re-running the sync is safe — it will pick up
                          only what is still outstanding.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warning" }) {
  const colour = value === 0 ? "text-foreground" : tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-foreground";
  return (
    <Card className="p-4">
      <div className={`text-2xl font-semibold tabular-nums ${colour}`}>{value}</div>
      <div className="mt-0.5 text-xs text-foreground-muted">{label}</div>
    </Card>
  );
}
