import type { User } from "@delta/shared";

/**
 * Super admin is a flag on the account, not a role — but it is what somebody
 * picking a role means, so it sits in the same list. Choosing it gives them the
 * Administrator role in this organization and the platform-wide flag on top.
 * Radix reads "" as unset, so the option needs a value of its own.
 *
 * Lives here rather than beside either screen: both the list and the edit
 * dialog need it, and the dialog is imported by the list.
 */
export const SUPER_ADMIN_OPTION = "__super_admin__";

/** What to call somebody's access. The flag outranks whatever role they hold. */
export function roleLabel(u: Pick<User, "role" | "isSuperAdmin">) {
  return u.isSuperAdmin ? "Super Admin" : u.role.name;
}
