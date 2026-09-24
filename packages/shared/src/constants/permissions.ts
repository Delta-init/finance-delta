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

  // Departments
  "department:read",
  "department:create",
  "department:update",
  "department:delete",

  // Sales (placeholders for later phases)
  "invoice:read",
  "invoice:write",
  /**
   * Raise and send your own invoices, and read only those.
   *
   * Deliberately narrower than `invoice:write`, which also covers deleting,
   * voiding and recording payments against anybody's invoice. Someone billing
   * their own work needs none of that.
   */
  "invoice:read:own",
  "invoice:write:own",

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
  /**
   * Submit expenses and read back only your own.
   *
   * `expense:read` is org-wide, so it cannot be given to somebody who should
   * see nothing but their own claims. These are additive: no existing role
   * changes behaviour by their being introduced.
   */
  "expense:read:own",
  "expense:write:own",

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
  "budget:read",
  "budget:read:own",
  "budget:manage",
  "budget:request",
  "budget:approve",
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

  // Payroll (HRMS integration). `write` covers the mapping layer and the
  // additions/deductions on a run; `approve` signs a run off; `pay` is the one
  // that moves money and is deliberately separate from the rest.
  "payroll:read",
  "payroll:write",
  "payroll:approve",
  "payroll:pay",
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
