import { Types } from "mongoose";

/*
 * Whose invoice a CS Portal course payment makes (the user, 2026-10-30: they all said "super admin" — the accountant
 * who approved the payment was put on the invoice as its salesperson). It is the CS Portal person who raised the
 * payment, else its initiating mentor, as their own account in this organization (payroll-only staff accounts
 * included): by email when CS Portal sent it, else by their exact name. Nobody matching: the approver, as before, with
 * a flag on the invoice to reassign it — as an enrolment from a sales CRM does with a rep who has no account here.
 */

type Row = {
  requestedBy?: string; requestedByEmail?: string; initiatingMentor?: string; initiatingMentorEmail?: string;
  decision?: { decidedById?: unknown };
};

export interface CourseSalesperson {
  id: string;
  name: string;
  /** Set when nobody matched and the approver stands in. */
  flag?: string;
  /** How it was found, for the fix-up script's report. */
  by: "email" | "name" | "approver";
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The person, by email or name, among this organization's accounts; null when none (or two share the name). */
export async function staffAccount(orgId: Types.ObjectId | string, who: { email?: string; name?: string }): Promise<{ id: string; name: string; by: "email" | "name" } | null> {
  const { User } = await import("../user/user.model");
  const member = { "memberships.organizationId": new Types.ObjectId(String(orgId)) };
  const email = String(who.email ?? "").trim().toLowerCase();
  if (email) {
    const users = await User.find({ ...member, email }).select("name status").lean<Array<{ _id: Types.ObjectId; name?: string; status?: string }>>();
    const u = users.find((x) => x.status === "active") ?? users[0];
    if (u) return { id: String(u._id), name: String(u.name ?? ""), by: "email" };
  }
  const name = String(who.name ?? "").trim().replace(/\s+/g, " ");
  if (name.length >= 3) {
    const users = await User.find({ ...member, name: { $regex: `^\\s*${escape(name).replace(/ /g, "\\s+")}\\s*$`, $options: "i" } })
      .select("name status").lean<Array<{ _id: Types.ObjectId; name?: string; status?: string }>>();
    const active = users.filter((x) => x.status === "active");
    const pick = active.length === 1 ? active[0] : users.length === 1 ? users[0] : null;
    if (pick) return { id: String(pick._id), name: String(pick.name ?? ""), by: "name" };
  }
  return null;
}

/** The salesperson for a course payment's invoice (see above). */
export async function courseSalesperson(orgId: Types.ObjectId | string, row: Row, approver: { id: string; name: string }): Promise<CourseSalesperson> {
  for (const who of [
    { email: row.requestedByEmail, name: row.requestedBy },
    { email: row.initiatingMentorEmail, name: row.initiatingMentor },
  ]) {
    if (!who.email && !who.name) continue;
    const found = await staffAccount(orgId, who);
    if (found) return found;
  }
  const raisedBy = row.requestedBy || row.initiatingMentor || row.requestedByEmail || row.initiatingMentorEmail;
  return {
    ...approver,
    by: "approver",
    ...(raisedBy ? { flag: `${raisedBy} (CS Portal) has no account here — reassign this invoice to the right person.` } : {}),
  };
}
