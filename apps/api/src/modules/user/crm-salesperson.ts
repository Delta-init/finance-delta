import { Types } from "mongoose";
import { User } from "./user.model";
import { hashPassword } from "../../lib/password";
import { payrollRoleId } from "../payroll-mapping/mapping.service";

/** What an enrolment from a CRM whose salesperson had no account here used to be flagged with. */
export const NO_ACCOUNT_FLAG = /has no account here/;

export interface CrmSalespersonAccount {
  _id: Types.ObjectId;
  name: string;
  /** A new account was made for them. */
  created: boolean;
  /** They had an account in another organization, and were added to this one. */
  joined: boolean;
}

/**
 * The account a sales CRM's salesperson is billed under in an organization (the user, 2026-11-05: a Bangalore close
 * by a rep with no account in finance went on the organization's first admin — "why the salesperson is different, and
 * why raised by became ACCOUNTS BLR").
 *
 * Theirs when they have one here, whatever its status: the CRM says they made the sale. Otherwise one is made the way
 * payroll mapping makes them — the "Payroll employee" role, no permissions, a password nobody knows — or, if their
 * email already has an account in another organization, that account joins this one with that role. Either way it
 * can sign in to nothing here; Users → Salespeople turns it into a real login when somebody needs one.
 *
 * Null for an address that isn't one: the caller keeps its fallback for that.
 */
export async function ensureCrmSalesperson(orgId: string, email: string, name: string): Promise<CrmSalespersonAccount | null> {
  const address = String(email ?? "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(address)) return null;
  const org = new Types.ObjectId(orgId);

  const existing = await User.findOne({ email: address });
  if (existing) {
    if (existing.memberships.some((m) => m.organizationId.equals(org))) {
      return { _id: existing._id as Types.ObjectId, name: String(existing.name), created: false, joined: false };
    }
    // Added only if still not a member — two enrolments arriving at once must not add it twice.
    await User.updateOne(
      { _id: existing._id, "memberships.organizationId": { $ne: org } },
      { $push: { memberships: { organizationId: org, roleId: await payrollRoleId(orgId), status: "active" } } },
    );
    return { _id: existing._id as Types.ObjectId, name: String(existing.name), created: false, joined: true };
  }

  try {
    const user = await User.create({
      name: String(name ?? "").trim() || address,
      email: address,
      // Nobody knows this one: there is nothing to sign in with until an administrator gives them a way in.
      passwordHash: await hashPassword(`${crypto.randomUUID()}${crypto.randomUUID()}`),
      status: "active",
      memberships: [{ organizationId: org, roleId: await payrollRoleId(orgId), status: "active" }],
    });
    return { _id: user._id as Types.ObjectId, name: String(user.name), created: true, joined: false };
  } catch (err) {
    // Made by another enrolment a moment ago: that one is theirs.
    if ((err as { code?: number }).code === 11000) return ensureCrmSalesperson(orgId, address, name);
    throw err;
  }
}
