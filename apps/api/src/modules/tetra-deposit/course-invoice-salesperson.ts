import { Types } from "mongoose";

/*
 * Whose invoice a CS Portal course payment makes (the user, 2026-10-30: they all said "super admin" — the accountant
 * who approved the payment was put on the invoice as its salesperson). It is the CS Portal person who raised the
 * payment, else its initiating mentor, as their own account in this organization (payroll-only staff accounts
 * included): by email when CS Portal sent it, else by their exact name, else by their CS Portal name being the part of
 * one account's email before the @ (CS staff often go by "athiravelayudan" there, "Athira Velayudhan" here).
 *
 * Nobody matching but CS Portal sent their email (the user: "missing sales person need to create also"): a
 * salesperson-only account is made for them, as the HRMS payroll does for its staff — nobody can sign in with it, and
 * Users → Salespeople can make it a real user. Without an email: the approver, as before, with a flag on the invoice to
 * reassign it — as an enrolment from a sales CRM does with a rep who has no account here.
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
  by: "email" | "name" | "username" | "created" | "approver";
}

/** The flag courseSalesperson puts on an invoice nobody could be found for. */
export const NO_ACCOUNT_FLAG = /\(CS Portal\) has no account here/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Account = { _id: Types.ObjectId; name?: string; status?: string };
/** The one active account, else the only one; null when none or several. */
const theOne = (users: Account[]) => {
  const active = users.filter((x) => x.status === "active");
  return active.length === 1 ? active[0] : users.length === 1 ? users[0] : null;
};

/** The person, by email, name or CS Portal username, among this organization's accounts; null when none (or two share it). */
export async function staffAccount(orgId: Types.ObjectId | string, who: { email?: string; name?: string }): Promise<{ id: string; name: string; by: "email" | "name" | "username" } | null> {
  const { User } = await import("../user/user.model");
  const member = { "memberships.organizationId": new Types.ObjectId(String(orgId)) };
  const email = String(who.email ?? "").trim().toLowerCase();
  if (email) {
    const users = await User.find({ ...member, email }).select("name status").lean<Account[]>();
    const u = users.find((x) => x.status === "active") ?? users[0];
    if (u) return { id: String(u._id), name: String(u.name ?? ""), by: "email" };
  }
  const name = String(who.name ?? "").trim().replace(/\s+/g, " ");
  if (name.length >= 3) {
    const pick = theOne(await User.find({ ...member, name: { $regex: `^\\s*${escape(name).replace(/ /g, "\\s+")}\\s*$`, $options: "i" } })
      .select("name status").lean<Account[]>());
    if (pick) return { id: String(pick._id), name: String(pick.name ?? ""), by: "name" };
  }
  // "jennifer.fernandez" is jennifer.fernandez@… — only for a name with no spaces (a username, not a full name);
  // emails are stored lower-cased.
  if (name.length >= 3 && !name.includes(" ") && !name.includes("@")) {
    const pick = theOne(await User.find({ ...member, email: { $regex: `^${escape(name.toLowerCase())}@` } }).select("name status").lean<Account[]>());
    if (pick) return { id: String(pick._id), name: String(pick.name ?? ""), by: "username" };
  }
  return null;
}

/** A salesperson-only account (no sign-in) for CS Portal staff finance has none for; null when the email is another organization's. */
export async function createStaffSalesperson(orgId: Types.ObjectId | string, who: { name: string; email: string }): Promise<{ id: string; name: string; created: boolean } | null> {
  const { ensureSalespersonLogin } = await import("../payroll-mapping/mapping.service");
  const name = who.name.trim() || who.email;
  const r = await ensureSalespersonLogin(String(orgId), { name, email: who.email, employeeCode: name });
  if (!r.userId) return null;
  const { User } = await import("../user/user.model");
  const u = await User.findById(r.userId).select("name").lean<{ name?: string }>();
  return { id: String(r.userId), name: String(u?.name ?? name), created: r.created };
}

/** The salesperson for a course payment's invoice (see above); create: false only reports, as the fix-up's dry run does. */
export async function courseSalesperson(
  orgId: Types.ObjectId | string, row: Row, approver: { id: string; name: string }, opts: { create?: boolean } = {},
): Promise<CourseSalesperson> {
  const people = [
    { email: row.requestedByEmail, name: row.requestedBy },
    { email: row.initiatingMentorEmail, name: row.initiatingMentor },
  ].filter((who) => who.email || who.name);
  for (const who of people) {
    const found = await staffAccount(orgId, who);
    if (found) return found;
  }
  if (opts.create) {
    for (const who of people) {
      const email = String(who.email ?? "").trim().toLowerCase();
      if (!email) continue;
      const made = await createStaffSalesperson(orgId, { name: String(who.name ?? ""), email });
      if (made) return { id: made.id, name: made.name, by: "created" };
    }
  }
  const raisedBy = row.requestedBy || row.initiatingMentor || row.requestedByEmail || row.initiatingMentorEmail;
  return {
    ...approver,
    by: "approver",
    ...(raisedBy ? { flag: `${raisedBy} (CS Portal) has no account here — reassign this invoice to the right person.` } : {}),
  };
}
