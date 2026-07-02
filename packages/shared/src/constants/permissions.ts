/**
 * Permission catalog — the single source of truth for what actions exist.
 * Format: `<resource>:<action>`. Roles hold a subset of these.
 * `*` is a wildcard meaning "all permissions" (reserved for the system admin role).
 */
export const PERMISSIONS = [
  // User & access management
  "user:read",
  "user:create",
  "user:update",
  "user:delete",
  "role:read",
  "role:create",
  "role:update",
  "role:delete",
  "organization:read",
  "organization:update",
  "organization:create",

  // Customers
  "customer:read",
  "customer:write",
  "customer:create",
  "customer:update",
  "customer:delete",

  // Quotations
  "quotation:read",
  "quotation:create",
  "quotation:update",
  "quotation:delete",

  // Sales orders
  "salesorder:read",
  "salesorder:create",
  "salesorder:update",
  "salesorder:delete",

  // Tags
  "tag:read",
  "tag:create",
  "tag:update",
  "tag:delete",

  // Sales (placeholders for later phases)
  "invoice:read",
  "invoice:write",

  // Vendors & payables
  "vendor:read",
  "vendor:create",
  "vendor:update",
  "vendor:delete",
  "po:read",
  "po:create",
  "po:update",
  "po:delete",
  "bill:read",
  "bill:create",
  "bill:update",
  "bill:delete",
  "bill:approve",

  // Expenses
  "expense:read",
  "expense:create",
  "expense:update",
  "expense:delete",
  "expense:approve",

  // Banking
  "banking:read",
  "banking:write",
  "banking:reconcile",

  // Inventory
  "inventory:read",
  "inventory:write",
  "inventory:adjust",
  "inventory:delete",

  // Finance
  "report:read",
  "ledger:read",
  "ledger:write",

  // Commissions
  "commission:read",
  "commission:write",
  "commission:approve",

  // Loans & Credit
  "loan:read",
  "loan:write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Wildcard granted to the admin role. */
export const WILDCARD = "*" as const;

/** Does a granted permission set satisfy a required permission? */
export function hasPermission(
  granted: readonly string[],
  required: Permission,
): boolean {
  if (granted.includes(WILDCARD)) return true;
  return granted.includes(required);
}
