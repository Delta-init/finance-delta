import { PERMISSIONS, WILDCARD, type Permission } from "./permissions";

/**
 * System roles seeded for every new organization. `isSystem` roles cannot be
 * deleted; the admin role's permissions are immutable (wildcard). Admins may
 * create additional custom roles on top of these.
 */
export interface SystemRoleDef {
  key: string;
  name: string;
  description: string;
  permissions: readonly string[];
  isSystem: true;
}

export const SYSTEM_ROLES: SystemRoleDef[] = [
  {
    key: "admin",
    name: "Administrator",
    description: "Full access to everything, including users and roles.",
    permissions: [WILDCARD],
    isSystem: true,
  },
  {
    key: "manager",
    name: "Manager",
    description: "Manage most resources; cannot manage users, roles, or org settings.",
    permissions: [
      "customer:read",
      "customer:write",
      "customer:create",
      "customer:update",
      "customer:delete",
      "quotation:read",
      "quotation:create",
      "quotation:update",
      "quotation:delete",
      "salesorder:read",
      "salesorder:create",
      "salesorder:update",
      "salesorder:delete",
      "tag:read",
      "tag:create",
      "tag:update",
      "tag:delete",
      "invoice:read",
      "invoice:write",
      "vendor:read",
      "vendor:create",
      "vendor:update",
      "po:read",
      "po:create",
      "po:update",
      "bill:read",
      "bill:create",
      "bill:update",
      "bill:approve",
      "expense:read",
      "expense:create",
      "expense:update",
      "expense:approve",
      "report:read",
      "ledger:read",
      "commission:read",
      "commission:write",
      "commission:approve",
      "loan:read",
      "loan:write",
      "organization:read",
    ] satisfies Permission[],
    isSystem: true,
  },
  {
    key: "accountant",
    name: "Accountant",
    description: "Manage finances and reports; cannot manage users or roles.",
    permissions: [
      "customer:read",
      "customer:write",
      "customer:create",
      "customer:update",
      "customer:delete",
      "quotation:read",
      "quotation:create",
      "quotation:update",
      "quotation:delete",
      "salesorder:read",
      "salesorder:create",
      "salesorder:update",
      "salesorder:delete",
      "tag:read",
      "tag:create",
      "tag:update",
      "tag:delete",
      "invoice:read",
      "invoice:write",
      "report:read",
      "ledger:read",
      "ledger:write",
      "organization:read",
    ] satisfies Permission[],
    isSystem: true,
  },
  {
    key: "salesperson",
    name: "Salesperson",
    description: "Manage customers, quotations and orders; no finance or admin access.",
    permissions: [
      "customer:read",
      "customer:write",
      "customer:create",
      "customer:update",
      "quotation:read",
      "quotation:create",
      "quotation:update",
      "quotation:delete",
      "salesorder:read",
      "salesorder:create",
      "salesorder:update",
      "tag:read",
      "tag:create",
      "tag:update",
      "invoice:read",
      "invoice:write",
    ] satisfies Permission[],
    isSystem: true,
  },
  {
    key: "employee",
    name: "Employee",
    description:
      "Submit expenses and raise invoices of their own. Sees nothing belonging to anybody else.",
    permissions: [
      // Their own claims and their own invoices — the `:own` variants, which
      // are enforced on the rows rather than on the route. The unscoped
      // `expense:read` and `invoice:read` would return the whole company.
      "expense:read:own",
      "expense:write:own",
      "invoice:read:own",
      "invoice:write:own",
      // Needed to name a client on an invoice. Read-only, but organization
      // wide: there is no per-salesperson customer ownership to scope to.
      "customer:read",
    ] satisfies Permission[],
    isSystem: true,
  },
  {
    key: "viewer",
    name: "Viewer",
    description: "Read-only access to records and reports.",
    permissions: [
      "customer:read",
      "quotation:read",
      "salesorder:read",
      "tag:read",
      "invoice:read",
      "report:read",
      "ledger:read",
      "organization:read",
    ] satisfies Permission[],
    isSystem: true,
  },
];

export const ADMIN_ROLE_KEY = "admin";

/** All non-wildcard permissions, for building custom roles in the UI. */
export const ASSIGNABLE_PERMISSIONS = PERMISSIONS;
