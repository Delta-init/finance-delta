"use client";

import { useSession } from "next-auth/react";
import { hasPermission, type Permission } from "@delta/shared";

/**
 * What the signed-in person is allowed to do.
 *
 * Used to decide what a screen offers, not to decide what it is allowed to
 * return — the server does that, on the rows themselves. Hiding a control here
 * spares somebody a button that only ever produces a refusal; it is not what
 * stops them reaching the data.
 *
 * `canAny` exists because several permissions now come in a broad and a narrow
 * form. Somebody with `expense:read:own` belongs on the expenses screen just as
 * much as somebody with `expense:read` — they will simply see fewer rows.
 */
export function useCan() {
  const { data: session } = useSession();
  const permissions = session?.user?.permissions ?? [];
  const isSuperAdmin = session?.user?.isSuperAdmin ?? false;

  const can = (permission: Permission): boolean =>
    isSuperAdmin || hasPermission(permissions, permission);

  return {
    can,
    canAny: (...permissions: Permission[]): boolean => permissions.some(can),
    /**
     * True when this person only ever sees their own records of this kind, so
     * a column naming whose they are says the same thing on every row.
     */
    ownOnly: (broad: Permission, own: Permission): boolean => !can(broad) && can(own),
    isSuperAdmin,
    /** Still loading. Treated as "no" so nothing flashes into view then vanishes. */
    ready: session !== undefined,
  };
}
