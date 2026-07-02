"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Building2, Loader2 } from "lucide-react";
import type { OrgChoiceItem, AuthSuccess } from "@delta/shared";
import { toast } from "@/lib/toast";

interface Props {
  orgs: OrgChoiceItem[];
}

export function OrgPickerModal({ orgs }: Props) {
  const { update } = useSession();
  const [loading, setLoading] = useState<string | null>(null);

  async function pick(orgId: string) {
    setLoading(orgId);
    try {
      const res = await fetch("/api/proxy/auth/switch-org", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: orgId }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? "Failed to select organization");
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
      toast.error(e instanceof Error ? e.message : "Failed to select organization");
      setLoading(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Building2 className="h-6 w-6 text-primary" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">Choose an Organization</h2>
          <p className="mt-1 text-sm text-foreground-muted">
            Your account is linked to multiple organizations. Select one to continue.
          </p>
        </div>

        <div className="space-y-2">
          {orgs.map((org) => (
            <button
              key={org.id}
              onClick={() => pick(org.id)}
              disabled={!!loading}
              className="flex w-full items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-60"
            >
              <div>
                <p className="text-sm font-semibold text-foreground">{org.name}</p>
                <p className="text-xs text-foreground-muted">{org.baseCurrency}</p>
              </div>
              {loading === org.id && (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
