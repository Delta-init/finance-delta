import { Types } from "mongoose";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";

/**
 * The accounts team, told about every approval request.
 *
 * Asked for: whatever the request is — an enrolment invoice, a claim, a bill,
 * a payroll month, a purchase or a fund request — everybody holding the
 * built-in Accountant role hears about it, as well as whoever that notice was
 * already going to. Found by the role's key rather than its name, so renaming
 * it on the Roles screen does not quietly stop the mail.
 *
 * Active people with an active membership only: somebody suspended, or
 * invited and never arrived, is not somebody to write to about money.
 */

const ACCOUNTANT_ROLE_KEY = "accountant";

function toObjectIds(ids: string[]): Types.ObjectId[] {
  return ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
}

export async function accountantEmails(
  organizationId: string | Types.ObjectId,
  excludeUserIds: string[] = [],
): Promise<string[]> {
  const orgId = new Types.ObjectId(String(organizationId));
  const roles = await Role.find({ organizationId: orgId, key: ACCOUNTANT_ROLE_KEY }).select("_id").lean();
  if (!roles.length) return [];
  const users = await User.find({
    _id: { $nin: toObjectIds(excludeUserIds) },
    status: "active",
    memberships: { $elemMatch: { organizationId: orgId, roleId: { $in: roles.map((r) => r._id) }, status: "active" } },
  }).select("email").lean();
  return users.map((u) => String(u.email ?? "")).filter(Boolean);
}

/**
 * `to` with the accountants added — each address once, whatever its case.
 *
 * `excludeUserIds` is whoever raised the request: they know about it already,
 * and "a request is waiting for you" about your own is noise.
 */
export async function withAccountants(
  organizationId: string | Types.ObjectId,
  to: string[],
  excludeUserIds: string[] = [],
): Promise<string[]> {
  const extra = await accountantEmails(organizationId, excludeUserIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of [...to, ...extra]) {
    const trimmed = address.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
