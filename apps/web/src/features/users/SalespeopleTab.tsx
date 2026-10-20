"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, UserPlus, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useCan } from "@/lib/use-can";
import { useRoles } from "@/features/roles/api";
import { useAllDepartments } from "@/features/departments/api";
import {
  useConvertSalesperson, useCreateCrmSalesperson, useSalespeople,
  type MissingSalespersonRow, type SalespersonRow,
} from "./api";

/*
 * Salespeople on the Users page (2026-10-20): the accounts made from the HRMS payroll so an employee can be named
 * as a salesperson — they can't sign in — and the CRM salespeople finance has no account for at all, their sales
 * billed against an administrator meanwhile. Either can be made a real user: a role here, and an invite to set
 * their own password or one set for them. A payroll account keeps its invoices and commission — it is the same
 * account.
 */

const NO_DEPARTMENT = "__none__";
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const CRM_NAME: Record<string, string> = { delta: "Sales CRM", draw: "Draw CRM", remote: "Remote CRM", banglore: "Banglore CRM" };

type Target = { kind: "payroll"; row: SalespersonRow } | { kind: "missing"; row: MissingSalespersonRow };

export function SalespeopleTab() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const h = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(h); }, [q]);
  const { data, isLoading } = useSalespeople(debounced);
  const { can } = useCan();
  const mayConvert = can("user:create");
  const [target, setTarget] = useState<Target | null>(null);

  const payroll = data?.payroll ?? [];
  const missing = data?.missing ?? [];
  const selling = payroll.filter((p) => p.invoices > 0).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search salespeople…" className="pl-8" />
        </div>
        <span className="text-sm text-foreground-muted">
          {payroll.length} on the payroll · {selling} with sales{missing.length ? ` · ${missing.length} not in finance yet` : ""}
        </span>
      </div>

      {missing.length > 0 && (
        <section className="rounded-lg border border-warning/40 bg-warning/5 p-4">
          <h3 className="text-sm font-semibold">Not in finance yet</h3>
          <p className="mb-3 text-xs text-foreground-muted">
            Salespeople a CRM sent sales for, with no account here — their invoices are billed against an administrator until they have one.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead><tr className="text-left text-xs text-foreground-muted">
                <th className="py-1.5 pr-3 font-medium">Name</th><th className="py-1.5 pr-3 font-medium">CRM</th>
                <th className="py-1.5 pr-3 font-medium">Sales</th><th className="py-1.5 pr-3 font-medium">Last sale</th><th />
              </tr></thead>
              <tbody>
                {missing.map((m) => (
                  <tr key={m.email} className="border-t border-border">
                    <td className="py-2 pr-3"><span className="font-medium">{m.name}</span><span className="block text-xs text-foreground-muted">{m.email}</span></td>
                    <td className="py-2 pr-3">{m.crms.map((c) => CRM_NAME[c] ?? c).join(", ") || "—"}</td>
                    <td className="py-2 pr-3 tabular-nums">{m.invoices}</td>
                    <td className="py-2 pr-3">{day(m.lastSaleAt)}</td>
                    <td className="py-2 text-right">
                      {mayConvert && (
                        <Button size="sm" onClick={() => setTarget({ kind: "missing", row: m })}>
                          <UserPlus className="h-4 w-4" /> Create account
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold">Salespeople on the payroll</h3>
        <p className="mb-3 text-xs text-foreground-muted">
          Made from the HRMS so they can be named on invoices and earn commission. They can&apos;t sign in until they&apos;re made a user.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="text-left text-xs text-foreground-muted">
              <th className="py-1.5 pr-3 font-medium">Name</th><th className="py-1.5 pr-3 font-medium">Department</th>
              <th className="py-1.5 pr-3 font-medium">Sales</th><th className="py-1.5 pr-3 font-medium">Last sale</th>
              <th className="py-1.5 pr-3 font-medium">CRM</th><th className="py-1.5 pr-3 font-medium">Status</th><th />
            </tr></thead>
            <tbody>
              {isLoading && !data && <tr><td colSpan={7} className="py-6 text-center text-foreground-muted">Loading…</td></tr>}
              {data && payroll.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-foreground-muted">No payroll salespeople match.</td></tr>}
              {payroll.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="py-2 pr-3"><span className="font-medium">{p.name}</span><span className="block text-xs text-foreground-muted">{p.email}</span></td>
                  <td className="py-2 pr-3">{p.department?.name ?? "—"}</td>
                  <td className="py-2 pr-3 tabular-nums">{p.invoices || "—"}</td>
                  <td className="py-2 pr-3">{day(p.lastSaleAt)}</td>
                  <td className="py-2 pr-3">{p.crms.map((c) => CRM_NAME[c] ?? c).join(", ") || "—"}</td>
                  <td className="py-2 pr-3">{p.status === "active" ? <Badge tone="neutral">Can&apos;t sign in</Badge> : <Badge tone="danger">Suspended</Badge>}</td>
                  <td className="py-2 text-right">
                    {mayConvert && (
                      <Button size="sm" variant="secondary" onClick={() => setTarget({ kind: "payroll", row: p })}>
                        <UserCheck className="h-4 w-4" /> Make a user
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {target && <MakeUserDialog target={target} onClose={() => setTarget(null)} />}
    </div>
  );
}

function MakeUserDialog({ target, onClose }: { target: Target; onClose: () => void }) {
  const { data: roles } = useRoles({ pageSize: 100, sort: "name", dir: "asc" });
  const { data: departments } = useAllDepartments();
  const convert = useConvertSalesperson();
  const createOne = useCreateCrmSalesperson();
  const pickable = useMemo(() => (roles?.data ?? []).filter((r) => r.key !== "payroll-employee"), [roles]);

  const [name, setName] = useState(target.row.name);
  const [email, setEmail] = useState(target.row.email);
  const [roleId, setRoleId] = useState("");
  const [departmentId, setDepartmentId] = useState(target.kind === "payroll" ? target.row.department?.id ?? "" : "");
  const [isManager, setIsManager] = useState(false);
  const [access, setAccess] = useState<"invite" | "password">("invite");
  const [password, setPassword] = useState("");
  const [moveInvoices, setMoveInvoices] = useState(true);

  // The Salesperson role when there is one: that is what most of them are.
  useEffect(() => {
    if (!roleId && pickable.length) setRoleId(pickable.find((r) => r.key === "salesperson")?.id ?? pickable[0]!.id);
  }, [pickable, roleId]);

  const busy = convert.isPending || createOne.isPending;
  const ready = !!roleId && (access === "invite" || password.length >= 8) && (target.kind === "payroll" || (name.trim().length >= 2 && /\S+@\S+\.\S+/.test(email)));

  async function submit() {
    const common = {
      roleId, departmentId: departmentId || null, isManager,
      sendInvite: access === "invite", ...(access === "password" ? { password } : {}),
    };
    try {
      if (target.kind === "payroll") {
        const r = await convert.mutateAsync({ id: target.row.id, input: common });
        toast.success(`${r.name} can sign in now`);
        if (r.invite) (r.invite.delivered ? toast.success : toast.error)(r.invite.message);
      } else {
        const r = await createOne.mutateAsync({ ...common, email: email.trim(), name: name.trim(), moveInvoices });
        toast.success(`${r.name} added${r.moved ? ` — ${r.moved} invoice${r.moved === 1 ? "" : "s"} moved to them` : ""}`);
        if (r.invite) (r.invite.delivered ? toast.success : toast.error)(r.invite.message);
      }
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save");
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{target.kind === "payroll" ? `Make ${target.row.name} a user` : "Create an account"}</DialogTitle>
          <DialogDescription>
            {target.kind === "payroll"
              ? "Same account — every invoice and commission line stays theirs. They get a role here and a way to sign in."
              : `${target.row.name} sold ${target.row.invoices} invoice${target.row.invoices === 1 ? "" : "s"} here with no account.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {target.kind === "missing" && (
            <>
              <div className="space-y-1.5"><Label htmlFor="mu-name">Name</Label><Input id="mu-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="mu-email">Email</Label><Input id="mu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            </>
          )}
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger><SelectValue placeholder="Select a role" /></SelectTrigger>
              <SelectContent>{pickable.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Department</Label>
            <Select value={departmentId || NO_DEPARTMENT} onValueChange={(v) => setDepartmentId(v === NO_DEPARTMENT ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="No department" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DEPARTMENT}>No department</SelectItem>
                {(departments ?? []).map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 text-sm">
            <Checkbox checked={isManager} onChange={() => setIsManager((v) => !v)} aria-label="Manager" /> Manager (approves late entries)
          </label>
          <div className="space-y-2 rounded-md border border-border p-3">
            <span className="block text-sm font-medium">How they get in</span>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" checked={access === "invite"} onChange={() => setAccess("invite")} /> Email them an invite to set their own password
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" checked={access === "password"} onChange={() => setAccess("password")} /> Set a password for them
            </label>
            {access === "password" && (
              <Input type="password" autoComplete="new-password" value={password} placeholder="At least 8 characters" onChange={(e) => setPassword(e.target.value)} />
            )}
          </div>
          {target.kind === "missing" && target.row.invoices > 0 && (
            <label className="flex cursor-pointer items-start gap-2.5 text-sm">
              <Checkbox checked={moveInvoices} onChange={() => setMoveInvoices((v) => !v)} aria-label="Move their invoices" className="mt-0.5" />
              <span>Move their {target.row.invoices} invoice{target.row.invoices === 1 ? "" : "s"} to them<span className="block text-xs text-foreground-muted">Billed against an administrator until now.</span></span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!ready} onClick={submit}>{target.kind === "payroll" ? "Make a user" : "Create account"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
