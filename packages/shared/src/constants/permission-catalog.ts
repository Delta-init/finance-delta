import { PERMISSIONS } from "./permissions";

/**
 * Permissions as a person reads them, rather than as the code checks them.
 *
 * The catalogue itself is a flat list of `resource:action` strings, which is
 * right for a route guard and wrong for anybody deciding what a role should be
 * able to do: ninety strings in a monospace grid is a wall, not a choice. This
 * turns the same list into sections, resources and plain-English actions
 * without inventing a second source of truth — every permission shown is
 * derived from PERMISSIONS, so one added there appears here on its own.
 */

export const RESOURCE_LABELS: Record<string, string> = {
  customer: "Customers",
  quotation: "Quotations",
  salesorder: "Sales orders",
  invoice: "Invoices",
  tag: "Tags",
  vendor: "Vendors",
  po: "Purchase orders",
  bill: "Bills",
  expense: "Expenses",
  banking: "Banking",
  inventory: "Inventory",
  ledger: "Ledger",
  payroll: "Payroll",
  commission: "Commissions",
  loan: "Loans & credit",
  report: "Reports",
  user: "Users",
  role: "Roles",
  department: "Departments",
  organization: "Organization settings",
};

export const ACTION_LABELS: Record<string, string> = {
  read: "View",
  create: "Create",
  update: "Edit",
  delete: "Delete",
  write: "Create & edit",
  approve: "Approve",
  pay: "Pay",
  adjust: "Adjust",
  reconcile: "Reconcile",
  "read:own": "View own only",
  "write:own": "Create & edit own only",
};

/**
 * A note for the actions whose name does not carry their meaning.
 *
 * The `:own` pair is the one people get wrong: holding the broad permission
 * alongside it silently wins, so granting both is not "extra safe", it is the
 * same as granting neither restriction.
 */
export const ACTION_NOTES: Record<string, string> = {
  "read:own": "Sees only records they entered. Ignored if the full View is also granted.",
  "write:own": "Creates, and edits only what they entered. Ignored if the full Create & edit is also granted.",
};

/** The order resources appear in, grouped the way the navigation is. */
export const PERMISSION_SECTIONS: { label: string; resources: string[] }[] = [
  { label: "Sales", resources: ["customer", "quotation", "salesorder", "invoice", "tag"] },
  { label: "Purchasing", resources: ["vendor", "po", "bill", "expense"] },
  { label: "Money", resources: ["banking", "inventory", "ledger", "payroll", "commission", "loan"] },
  { label: "Reporting", resources: ["report"] },
  { label: "Administration", resources: ["user", "role", "department", "organization"] },
];

export interface PermissionItem {
  /** The permission string as stored on a role. */
  value: string;
  /** The action part, e.g. "read" or "read:own". */
  action: string;
  label: string;
  note?: string;
}

export interface ResourceGroup {
  resource: string;
  label: string;
  items: PermissionItem[];
}

const resourceOf = (p: string) => p.slice(0, p.indexOf(":"));
const actionOf = (p: string) => p.slice(p.indexOf(":") + 1);

const humanise = (s: string) =>
  s.replace(/[:_]/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * Every permission, grouped by resource and ordered by section.
 *
 * A resource nobody thought to put in a section still appears, in an
 * "Other" group at the end — a permission that exists but cannot be granted
 * because the UI forgot about it is worse than an ugly heading.
 */
export function permissionSections(): { label: string; groups: ResourceGroup[] }[] {
  const byResource = new Map<string, PermissionItem[]>();
  for (const value of PERMISSIONS) {
    const resource = resourceOf(value);
    const action = actionOf(value);
    const item: PermissionItem = {
      value,
      action,
      label: ACTION_LABELS[action] ?? humanise(action),
      note: ACTION_NOTES[action],
    };
    const list = byResource.get(resource);
    if (list) list.push(item);
    else byResource.set(resource, [item]);
  }

  const placed = new Set<string>();
  const sections = PERMISSION_SECTIONS.map((s) => ({
    label: s.label,
    groups: s.resources
      .filter((r) => byResource.has(r))
      .map((r) => {
        placed.add(r);
        return { resource: r, label: RESOURCE_LABELS[r] ?? humanise(r), items: byResource.get(r)! };
      }),
  })).filter((s) => s.groups.length > 0);

  const leftover = [...byResource.keys()].filter((r) => !placed.has(r));
  if (leftover.length > 0) {
    sections.push({
      label: "Other",
      groups: leftover.map((r) => ({
        resource: r,
        label: RESOURCE_LABELS[r] ?? humanise(r),
        items: byResource.get(r)!,
      })),
    });
  }
  return sections;
}

/**
 * A short readable summary of what a role can reach, for a table cell.
 *
 * Names the resources rather than counting permissions: "12 permissions" tells
 * somebody choosing a role for a new colleague nothing at all.
 */
export function summarisePermissions(permissions: readonly string[], max = 4): string {
  if (permissions.includes("*")) return "Everything";
  if (permissions.length === 0) return "Nothing";

  const resources: string[] = [];
  for (const p of permissions) {
    const r = resourceOf(p);
    if (r && !resources.includes(r)) resources.push(r);
  }
  const named = resources.slice(0, max).map((r) => RESOURCE_LABELS[r] ?? humanise(r));
  const rest = resources.length - named.length;
  return rest > 0 ? `${named.join(", ")} +${rest} more` : named.join(", ");
}
