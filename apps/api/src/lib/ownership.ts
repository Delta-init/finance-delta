import { hasPermission, type Permission } from "@delta/shared";
import type { AuthContext } from "../middleware/auth";
import { AppError } from "./http";

/**
 * How much of a collection the caller is entitled to see.
 *
 * The permission on the route answers "may they call this at all". It cannot
 * answer "whose rows", because the route has not read any rows yet. So the
 * route checks the permission and the service applies the scope — and the
 * scope is a value that has to be passed, rather than a flag that can be
 * forgotten, because forgetting it returns the whole organization.
 */
export type Scope =
  | { all: true }
  | { all: false; userId: string };

/**
 * Work out, from what the caller holds, whether they are limited to their own
 * records.
 *
 * The broad permission wins where both are held: an administrator who has also
 * been granted the narrow one is not thereby restricted.
 *
 * Throws when neither is held. That case should already have been stopped at
 * the route, and reaching here means it was not — so it fails closed rather
 * than falling through to the broader answer.
 */
export function resolveScope(
  auth: AuthContext,
  broad: Permission,
  own: Permission,
): Scope {
  if (auth.isSuperAdmin) return { all: true };
  if (hasPermission(auth.permissions, broad)) return { all: true };
  if (hasPermission(auth.permissions, own)) return { all: false, userId: auth.userId };
  throw new AppError("FORBIDDEN", `Missing required permission: ${broad}`);
}

/**
 * A Mongo filter fragment for the scope, keyed by whichever field records who
 * a row belongs to — `submittedById` on an expense, `salespersonId` on an
 * invoice.
 *
 * Returns an empty object for an unrestricted caller so it can be spread into
 * a filter unconditionally.
 */
export function scopeFilter(scope: Scope, ownerField: string): Record<string, unknown> {
  return scope.all ? {} : { [ownerField]: scope.userId };
}

/**
 * Refuse a single record the caller does not own.
 *
 * Reported as "not found" rather than "forbidden" on purpose: an id that
 * answers differently depending on whether it exists tells someone iterating
 * ids which ones are real, and a stranger's expense should be indistinguishable
 * from one that was never there.
 */
export function assertOwned(
  scope: Scope,
  ownerId: unknown,
  what: string,
): void {
  if (scope.all) return;
  if (String(ownerId ?? "") !== scope.userId) {
    throw new AppError("NOT_FOUND", `${what} not found`);
  }
}
