"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Users2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StateBadge } from "./state-badge";
import type { EmpRow, SyncDecision } from "./types";

const ACTIONS: Record<EmpRow["state"], SyncDecision["action"][]> = {
  linked: ["link", "skip"],
  proposed: ["link", "create", "skip"],
  new: ["create", "link", "skip"],
  conflict: ["skip", "link", "create"],
  orphaned: ["skip", "deactivate"],
};

/**
 * What an action will do to one particular row.
 *
 * Not a flat lookup, because the same action means different things depending
 * on where the row started. "Import + link login" on somebody already mapped
 * and with no login to attach was both wrong statements at once.
 */
function actionLabel(action: SyncDecision["action"], row: EmpRow, hasLogin: boolean): string {
  // Importing somebody with an email always gives them a salesperson login —
  // that is what makes them selectable on an invoice — so the label says so.
  // It used to read a bare "Import" whenever no *existing* login had been
  // matched, which is exactly the case where one is about to be created.
  const willCreateLogin = !hasLogin && Boolean(row.email);
  switch (action) {
    case "skip": return "Leave alone";
    case "deactivate": return "Deactivate here";
    case "create":
      if (row.state === "linked") return "Refresh from HRMS";
      return willCreateLogin ? "Import + create login" : "Import (no login)";
    case "link":
      if (row.state === "linked") return hasLogin ? "Refresh + keep login" : "Refresh from HRMS";
      if (hasLogin) return "Import + link login";
      return willCreateLogin ? "Import + create login" : "Import (no login)";
  }
}

export function EmployeeReview({
  rows,
  decisions,
  onChange,
  users,
  usersTruncated = false,
}: {
  rows: EmpRow[];
  decisions: Record<string, SyncDecision>;
  onChange: (hrmsId: string, next: SyncDecision) => void;
  users: { id: string; name: string; email: string }[];
  /** True when this organization has more logins than the picker is showing. */
  usersTruncated?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("all");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "issues" && r.issues.length === 0) return false;
      if (filter !== "all" && filter !== "issues" && r.state !== filter) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.employeeCode.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q)
      );
    });
  }, [rows, search, filter]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users2 className="h-4 w-4" /> People
        </CardTitle>
        <CardDescription>
          Every row is a proposal, not a decision already taken. Nothing is written until you apply.
          Rows marked <span className="font-medium">Needs a decision</span> default to being left
          alone — the evidence for matching them is an email address, and guessing wrong points
          somebody&rsquo;s salary at the wrong person.
        </CardDescription>
      </CardHeader>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Input
          placeholder="Search name, code or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:w-64"
        />
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            <SelectItem value="issues">Anything with a warning</SelectItem>
            <SelectItem value="new">New</SelectItem>
            <SelectItem value="proposed">Match found</SelectItem>
            <SelectItem value="linked">Already mapped</SelectItem>
            <SelectItem value="conflict">Needs a decision</SelectItem>
            <SelectItem value="orphaned">Gone from HRMS</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-foreground-muted">
          {visible.length} of {rows.length}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-muted">
            <tr>
              <th className="px-5 py-3 font-medium">Employee</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Warnings</th>
              <th className="px-5 py-3 font-medium">Action</th>
              <th className="px-5 py-3 font-medium">Finance login</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const decision = decisions[`employee:${row.hrmsEmployeeId}`];
              const action = decision?.action ?? "skip";
              const allowed = ACTIONS[row.state];
              return (
                <tr key={row.hrmsEmployeeId} className="border-b border-border align-top last:border-0">
                  <td className="px-5 py-3">
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-foreground-muted">
                      {row.employeeCode}
                      {row.email ? ` · ${row.email}` : ""}
                    </div>
                    {row.changes.length > 0 && (
                      <div className="mt-1 text-xs text-warning">
                        {row.changes.map((c) => `${c.field}: ${c.from || "—"} → ${c.to || "—"}`).join(", ")}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <StateBadge state={row.state} />
                    {row.hrmsStatus === "terminated" && (
                      <div className="mt-1 text-xs text-foreground-muted">Left the company</div>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    {row.issues.length === 0 ? (
                      <span className="text-foreground-muted">—</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {row.issues.map((i) => (
                          <li key={i} className="flex items-start gap-1.5 text-xs text-warning">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            <span>{i}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <Select
                      value={action}
                      onValueChange={(v) =>
                        onChange(row.hrmsEmployeeId, {
                          kind: "employee",
                          hrmsId: row.hrmsEmployeeId,
                          action: v as SyncDecision["action"],
                          targetUserId: decision?.targetUserId,
                        })
                      }
                    >
                      <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {allowed.map((a) => (
                          <SelectItem key={a} value={a}>
                            {actionLabel(a, row, Boolean(decision?.targetUserId ?? row.userId))}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-5 py-3">
                    {action === "link" ? (
                      <Select
                        value={decision?.targetUserId ?? ""}
                        onValueChange={(v) =>
                          onChange(row.hrmsEmployeeId, {
                            kind: "employee", hrmsId: row.hrmsEmployeeId, action: "link", targetUserId: v || undefined,
                          })
                        }
                      >
                        <SelectTrigger className="w-[220px]">
                          <SelectValue placeholder="No login — import only" />
                        </SelectTrigger>
                        <SelectContent>
                          {users.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                              {u.name} · {u.email}
                            </SelectItem>
                          ))}
                          {usersTruncated && (
                            <p className="px-2 py-1.5 text-xs text-foreground-muted">
                              Only the first 100 logins are listed.
                            </p>
                          )}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-xs text-foreground-muted">
                        {/* "—" read as "nothing will happen here", when in fact
                            a login is about to be created. Say which. */}
                        {row.userName
                          ?? (row.userId
                            ? "Already linked"
                            : decision?.action === "skip" || decision?.action === "deactivate"
                              ? "—"
                              : row.email
                                ? "Will be created"
                                : "No email — cannot be a salesperson")}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-foreground-muted">
                  Nothing matches that filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Bulk helpers. Conflicts are deliberately excluded from every one of them. */
export function BulkActions({
  rows,
  onBulk,
}: {
  rows: EmpRow[];
  onBulk: (states: EmpRow["state"][], action: SyncDecision["action"]) => void;
}) {
  const counts = {
    proposed: rows.filter((r) => r.state === "proposed").length,
    fresh: rows.filter((r) => r.state === "new").length,
    orphaned: rows.filter((r) => r.state === "orphaned").length,
  };
  // Only offered when there is something to act on. Three greyed-out buttons
  // all reading "0" is noise on a screen whose whole job is telling somebody
  // what needs their attention.
  const anything = counts.proposed + counts.fresh + counts.orphaned > 0;
  if (!anything) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {counts.proposed > 0 && (
        <Button variant="secondary" size="sm" onClick={() => onBulk(["proposed"], "link")}>
          Accept {counts.proposed} suggested match{counts.proposed === 1 ? "" : "es"}
        </Button>
      )}
      {counts.fresh > 0 && (
        <Button variant="secondary" size="sm" onClick={() => onBulk(["new"], "create")}>
          Import {counts.fresh} new
        </Button>
      )}
      {counts.orphaned > 0 && (
        <Button variant="secondary" size="sm" onClick={() => onBulk(["orphaned"], "deactivate")}>
          Deactivate {counts.orphaned} missing
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={() => onBulk(["linked", "proposed", "new", "conflict", "orphaned"], "skip")}>
        Clear all
      </Button>
    </div>
  );
}
