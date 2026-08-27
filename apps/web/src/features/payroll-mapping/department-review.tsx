"use client";

import { Building2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StateBadge } from "./state-badge";
import type { DeptRow, SyncDecision } from "./types";

/**
 * Departments are reviewed before people, and shown first for that reason: an
 * employee whose department is unmapped is imported without one, and a payroll
 * line with no department cannot be reported on. The order is not cosmetic —
 * `applySync` writes departments first so that employees can resolve against
 * the links this step creates.
 */
export function DepartmentReview({
  rows,
  decisions,
  onChange,
  financeDepartments,
}: {
  rows: DeptRow[];
  decisions: Record<string, SyncDecision>;
  onChange: (hrmsId: string, next: SyncDecision) => void;
  financeDepartments: { id: string; name: string }[];
}) {
  if (!rows.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-4 w-4" /> Departments
        </CardTitle>
        <CardDescription>
          Map each HRMS department to a finance one. Several HRMS departments may point at the same
          finance department — that is normal when more than one entity pays out of this book.
        </CardDescription>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
            <tr>
              <th className="px-5 py-3 font-medium">HRMS department</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Action</th>
              <th className="px-5 py-3 font-medium">Finance department</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = `department:${row.hrmsDepartmentId}`;
              const decision = decisions[key];
              const action = decision?.action ?? "skip";
              return (
                <tr key={row.hrmsDepartmentId} className="border-b border-border last:border-0">
                  <td className="px-5 py-3">
                    <div className="font-medium">{row.hrmsDepartmentName}</div>
                    <div className="text-xs text-foreground-muted">{row.reason}</div>
                  </td>
                  <td className="px-5 py-3"><StateBadge state={row.state} /></td>
                  <td className="px-5 py-3">
                    <Select
                      value={action}
                      onValueChange={(v) =>
                        onChange(row.hrmsDepartmentId, {
                          kind: "department",
                          hrmsId: row.hrmsDepartmentId,
                          action: v as SyncDecision["action"],
                          targetDepartmentId: decision?.targetDepartmentId,
                        })
                      }
                    >
                      <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="skip">Leave alone</SelectItem>
                        <SelectItem value="link">Map to existing</SelectItem>
                        <SelectItem value="create">Create in finance</SelectItem>
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-5 py-3">
                    {action === "link" ? (
                      <Select
                        value={decision?.targetDepartmentId ?? ""}
                        onValueChange={(v) =>
                          onChange(row.hrmsDepartmentId, {
                            kind: "department", hrmsId: row.hrmsDepartmentId, action: "link", targetDepartmentId: v,
                          })
                        }
                      >
                        <SelectTrigger className="w-[200px]"><SelectValue placeholder="Pick a department" /></SelectTrigger>
                        <SelectContent>
                          {financeDepartments.map((d) => (
                            <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : action === "create" ? (
                      <span className="text-foreground-muted">
                        Will create &ldquo;{row.hrmsDepartmentName}&rdquo;
                      </span>
                    ) : (
                      <span className="text-foreground-muted">{row.departmentName ?? "—"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
