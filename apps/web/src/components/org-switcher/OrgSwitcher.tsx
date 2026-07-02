"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { ChevronsUpDown, Check, Plus, Loader2, Building2, Settings, ExternalLink } from "lucide-react";
import Link from "next/link";
import type { AuthSuccess, CreateOrganizationInput } from "@delta/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useMyOrgs, useCreateOrganization, type OrgMembershipItem } from "@/features/organization/api";
import { usePlatformOrgs } from "@/features/platform/api";
import { toast } from "@/lib/toast";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

const CURRENCIES = ["AED", "USD", "EUR", "GBP", "INR", "SAR", "QAR", "KWD", "BHD", "OMR"];

function OrgAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md bg-white/20 font-semibold text-primary-foreground",
        size === "sm" ? "h-5 w-5 text-[10px]" : "h-7 w-7 text-xs",
      )}
    >
      {initials}
    </span>
  );
}

function CreateOrgDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}) {
  const createOrg = useCreateOrganization();
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [currency, setCurrency] = useState("AED");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const org = await createOrg.mutateAsync({ name, legalName: legalName || undefined, baseCurrency: currency } as CreateOrganizationInput);
      toast.success(`"${org.name}" created`);
      setName("");
      setLegalName("");
      setCurrency("AED");
      onCreated(org.id, org.name);
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create organization");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Organization</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Name *</label>
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Delta UAE"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Legal name</label>
            <input
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Delta Finance LLC"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Base currency</label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={createOrg.isPending}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OrgSwitcher() {
  const { data: session, update } = useSession();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  const isSuperAdmin = session?.user?.isSuperAdmin ?? false;
  const currentOrgId = session?.user?.organizationId ?? "";
  const currentOrgName = session?.user?.orgName || "Organization";

  const { data: myOrgs = [] } = useMyOrgs();
  const { data: allOrgs = [] } = usePlatformOrgs();

  // Super admin sees all orgs; regular users see only their memberships.
  const orgs: Array<{ id: string; name: string; baseCurrency: string }> = isSuperAdmin
    ? allOrgs.map((o) => ({ id: o.id, name: o.name, baseCurrency: o.baseCurrency }))
    : myOrgs.map((o) => ({ id: o.id, name: o.name, baseCurrency: o.baseCurrency }));

  // Keyboard shortcut: ⌘1–⌘9 to switch orgs.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) return;
      const idx = parseInt(e.key) - 1;
      if (isNaN(idx) || idx < 0 || idx >= orgs.length) return;
      const org = orgs[idx];
      if (org && org.id !== currentOrgId) {
        e.preventDefault();
        switchTo(org.id);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgs, currentOrgId]);

  async function switchTo(orgId: string) {
    if (orgId === currentOrgId) { setOpen(false); return; }
    setSwitching(orgId);
    setOpen(false);
    try {
      const res = await fetch("/api/proxy/auth/switch-org", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: orgId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? "Switch failed");
      }
      const json = (await res.json()) as { data: AuthSuccess };
      const data = json.data;
      await update({
        id: data.user.id,
        organizationId: data.user.organizationId,
        orgName: data.user.orgName ?? "",
        roleKey: data.user.roleKey,
        roleName: data.user.roleName,
        permissions: data.user.permissions,
        isSuperAdmin: data.user.isSuperAdmin ?? false,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        needsOrgChoice: false,
      });
      window.location.href = "/dashboard";
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to switch organization");
      setSwitching(null);
    }
  }

  const canCreate = isSuperAdmin || (session?.user?.permissions ?? []).includes("organization:create");

  if (!session?.user) return null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20">
            <OrgAvatar name={currentOrgName} />
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-sm font-semibold leading-tight text-primary-foreground">
                {currentOrgName}
              </p>
              <p className="truncate text-[11px] leading-tight text-primary-foreground/60">
                {isSuperAdmin ? "Super Admin" : (session.user.roleName || "Member")}
              </p>
            </div>
            {switching ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary-foreground/40" />
            ) : (
              <ChevronsUpDown className="h-4 w-4 shrink-0 text-primary-foreground/40" />
            )}
          </button>
        </PopoverTrigger>

        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={8}
          className="w-64 p-1"
        >
          {/* Section label */}
          <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-foreground-muted">
            Organizations
          </p>

          {/* Org list */}
          <div className="space-y-px">
            {orgs.map((org, i) => {
              const isCurrent = org.id === currentOrgId;
              return (
                <button
                  key={org.id}
                  onClick={() => switchTo(org.id)}
                  disabled={!!switching}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors",
                    isCurrent
                      ? "bg-surface-muted text-foreground"
                      : "text-foreground hover:bg-surface-muted",
                    "disabled:opacity-50",
                  )}
                >
                  {/* Org avatar */}
                  <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-background text-[10px] font-semibold text-foreground">
                    {org.name.slice(0, 2).toUpperCase()}
                  </span>

                  <span className="flex-1 truncate font-medium">{org.name}</span>

                  <span className="flex shrink-0 items-center gap-1.5">
                    {/* Keyboard shortcut badge */}
                    {i < 9 && (
                      <kbd className="rounded border border-border bg-surface-muted px-1 py-0.5 font-mono text-[10px] text-foreground-muted">
                        ⌘{i + 1}
                      </kbd>
                    )}
                    {/* Checkmark for current */}
                    {isCurrent && <Check className="h-3.5 w-3.5 text-primary" />}
                    {switching === org.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                  </span>
                </button>
              );
            })}

            {orgs.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-foreground-muted">No organizations</p>
            )}
          </div>

          {/* Divider */}
          <div className="my-1 border-t border-border" />

          {/* Actions */}
          {canCreate && (
            <button
              onClick={() => { setOpen(false); setCreateOpen(true); }}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-muted"
            >
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-background">
                <Plus className="h-3.5 w-3.5 text-foreground-muted" />
              </span>
              <span className="font-medium text-foreground-muted">Add organization</span>
            </button>
          )}

          {isSuperAdmin && (
            <Link
              href="/platform"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-muted"
            >
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                <Building2 className="h-3.5 w-3.5 text-foreground-muted" />
              </span>
              <span className="font-medium text-foreground-muted">Manage all orgs</span>
              <ExternalLink className="ml-auto h-3 w-3 text-foreground-subtle" />
            </Link>
          )}

          {/* Current org settings shortcut */}
          {currentOrgId && (
            <Link
              href="/settings"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-muted"
            >
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                <Settings className="h-3.5 w-3.5 text-foreground-muted" />
              </span>
              <span className="font-medium text-foreground-muted">Organization settings</span>
            </Link>
          )}
        </PopoverContent>
      </Popover>

      <CreateOrgDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(_id, _name) => {}}
      />
    </>
  );
}
