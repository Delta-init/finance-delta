"use client";

import { useSession } from "next-auth/react";
import type { AuthSuccess } from "@delta/shared";

/**
 * Moves the session to another organization the user belongs to — what the organization switcher does — and leaves
 * where to go next to the caller (2026-10-21: an old-date entry of another organization opens there).
 */
export function useSwitchOrganization() {
  const { update } = useSession();
  return async function switchOrganization(orgId: string): Promise<void> {
    const res = await fetch("/api/proxy/auth/switch-org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: orgId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message ?? "Switch failed");
    }
    const data = ((await res.json()) as { data: AuthSuccess }).data;
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
      baseCurrency: data.user.baseCurrency ?? "AED",
    });
  };
}
