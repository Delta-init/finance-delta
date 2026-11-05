/**
 * Enrolments billed to an organization's first admin because their CRM salesperson had no account in it (the user,
 * 2026-11-05: a Bangalore close showed "Salesperson: ACCOUNTS BLR" in the list and "Raised by ACCOUNTS BLR", while its
 * enrolment named the CRM's rep).
 *
 * Since then intake gives such a salesperson an account (no access) and bills the invoice to them. This moves the ones
 * from before: every invoice still flagged "… has no account here — reassign …" that says the CRM's salesperson's
 * email goes to that person — their account here, or one made for them (user/crm-salesperson.ts) — and the flag comes
 * off. Nothing else on the invoice changes.
 *
 * Reads and prints only, unless --write; --write saves an undo file first and adds to it as it goes (--undo <file> puts
 * each invoice back on who it was on, with its flag, and takes off the accounts and memberships it made, unless
 * something else uses them by then). Run it from apps/api on the server:
 *
 *   bun src/scripts/crm-salesperson-backfill.ts                      # what it would move
 *   bun src/scripts/crm-salesperson-backfill.ts --write --expect N   # N = the "would move" count shown
 *   bun src/scripts/crm-salesperson-backfill.ts --undo <file>
 */
import mongoose, { Types } from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";

export interface Row { invoice: string; organization: string; from: string; to: string; email: string; outcome: "would move" | "moved" | "left"; detail: string }
interface Undo {
  invoices: Array<{ id: string; number: string; salespersonId: string; salespersonName: string; flags: string[] }>;
  created: string[];
  joined: Array<{ userId: string; organizationId: string }>;
}

export async function backfillCrmSalespeople(o: { write: boolean; expect?: number; undoFile?: string }): Promise<{ rows: Row[]; undoFile?: string }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { User } = await import("../modules/user/user.model");
  const { Organization } = await import("../modules/organization/organization.model");
  const { ensureCrmSalesperson, NO_ACCOUNT_FLAG } = await import("../modules/user/crm-salesperson");

  const invoices = await Invoice.find({ "external.flags": NO_ACCOUNT_FLAG })
    .select("organizationId invoiceNumber salespersonId salespersonName enrolment.meetingBy enrolment.meetingByEmail external.flags")
    .sort({ organizationId: 1, invoiceNumber: 1 })
    .lean<any[]>();
  const orgNames = new Map(
    (await Organization.find({ _id: { $in: [...new Set(invoices.map((i) => String(i.organizationId)))] } }).select("name").lean<any[]>())
      .map((x) => [String(x._id), String(x.name)]),
  );

  const plans: { inv: any; row: Row }[] = [];
  for (const inv of invoices) {
    const orgId = String(inv.organizationId);
    const email = String(inv.enrolment?.meetingByEmail ?? "").trim().toLowerCase();
    const base = {
      invoice: String(inv.invoiceNumber), organization: orgNames.get(orgId) ?? orgId,
      from: String(inv.salespersonName ?? ""), to: String(inv.enrolment?.meetingBy ?? ""), email,
    };
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      plans.push({ inv, row: { ...base, outcome: "left", detail: "the CRM sent no email for its salesperson — reassign it by hand" } });
      continue;
    }
    const user = await User.findOne({ email }).select("name memberships.organizationId").lean<any>();
    const here = !!user?.memberships?.some((m: any) => String(m.organizationId) === orgId);
    if (here && String(user._id) === String(inv.salespersonId)) {
      plans.push({ inv, row: { ...base, outcome: "would move", detail: "already theirs — only the flag comes off" } });
      continue;
    }
    plans.push({
      inv,
      row: {
        ...base, to: here || user ? String(user.name) : base.to || email, outcome: "would move",
        detail: here ? "their account here" : user ? "their account from another organization joins this one (no access)" : "an account is made for them (no access)",
      },
    });
  }

  const todo = plans.filter((p) => p.row.outcome === "would move");
  if (!o.write) return { rows: plans.map((p) => p.row) };
  if (o.expect !== undefined && o.expect !== todo.length) {
    throw new Error(`--expect ${o.expect}, but ${todo.length} would be moved now — run it again without --write and check`);
  }

  const undo: Undo = { invoices: [], created: [], joined: [] };
  const undoFile = o.undoFile ?? `crm-salesperson-backfill-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const save = () => {
    writeFileSync(undoFile, JSON.stringify(undo, null, 2));
    if (!Array.isArray((JSON.parse(readFileSync(undoFile, "utf8")) as Undo).invoices)) throw new Error(`The undo file ${undoFile} didn't read back — stopped`);
  };
  save();

  for (const p of todo) {
    const orgId = String(p.inv.organizationId);
    const made = await ensureCrmSalesperson(orgId, p.row.email, String(p.inv.enrolment?.meetingBy ?? ""));
    if (!made) { p.row.outcome = "left"; p.row.detail = "no account could be found or made"; continue; }
    if (made.created) undo.created.push(String(made._id));
    if (made.joined) undo.joined.push({ userId: String(made._id), organizationId: orgId });
    undo.invoices.push({
      id: String(p.inv._id), number: p.row.invoice,
      salespersonId: String(p.inv.salespersonId ?? ""), salespersonName: String(p.inv.salespersonName ?? ""),
      flags: (p.inv.external?.flags ?? []).filter((f: string) => NO_ACCOUNT_FLAG.test(f)),
    });
    save();
    // Only while it is still as read: somebody reassigning it meanwhile is not undone here.
    const r = await Invoice.updateOne(
      { _id: p.inv._id, salespersonId: p.inv.salespersonId },
      { $set: { salespersonId: made._id, salespersonName: made.name }, $pull: { "external.flags": NO_ACCOUNT_FLAG } },
    );
    if (!r.matchedCount) {
      undo.invoices.pop();
      save();
      p.row.outcome = "left";
      p.row.detail = "its salesperson changed since it was read";
      continue;
    }
    p.row.outcome = "moved";
    p.row.to = made.name;
  }
  return { rows: plans.map((p) => p.row), undoFile };
}

/** Puts each invoice back on who it was on, flagged as before; takes off the accounts and memberships it made. */
export async function undoCrmSalespeople(file: string): Promise<{ invoices: number; removedUsers: number; removedMemberships: number; kept: string[] }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { User } = await import("../modules/user/user.model");
  const u = JSON.parse(readFileSync(file, "utf8")) as Undo;
  let invoices = 0;
  for (const inv of u.invoices) {
    const r = await Invoice.updateOne(
      { _id: new Types.ObjectId(inv.id) },
      {
        $set: { salespersonId: new Types.ObjectId(inv.salespersonId), salespersonName: inv.salespersonName },
        $addToSet: { "external.flags": { $each: inv.flags } },
      },
    );
    invoices += r.modifiedCount;
  }
  // An account or membership it made goes again — not one an invoice has been billed to since.
  const kept: string[] = [];
  let removedUsers = 0, removedMemberships = 0;
  for (const id of u.created) {
    if (await Invoice.exists({ salespersonId: new Types.ObjectId(id) })) { kept.push(id); continue; }
    removedUsers += (await User.deleteOne({ _id: new Types.ObjectId(id) })).deletedCount;
  }
  for (const j of u.joined) {
    if (await Invoice.exists({ organizationId: new Types.ObjectId(j.organizationId), salespersonId: new Types.ObjectId(j.userId) })) { kept.push(j.userId); continue; }
    const r = await User.updateOne(
      { _id: new Types.ObjectId(j.userId) },
      { $pull: { memberships: { organizationId: new Types.ObjectId(j.organizationId) } } },
    );
    removedMemberships += r.modifiedCount;
  }
  return { invoices, removedUsers, removedMemberships, kept };
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    if (arg("--undo")) {
      const r = await undoCrmSalespeople(arg("--undo"));
      console.log(`Put ${r.invoices} invoice(s) back; took off ${r.removedUsers} account(s) and ${r.removedMemberships} membership(s) it made${r.kept.length ? `; kept ${r.kept.length} still billed to since` : ""}.`);
    } else {
      const write = argv.includes("--write");
      const { rows, undoFile } = await backfillCrmSalespeople({ write, expect: arg("--expect") ? Number(arg("--expect")) : undefined });
      for (const r of rows) {
        console.log(`${r.invoice.padEnd(10)} ${r.organization.slice(0, 22).padEnd(22)} ${r.from.slice(0, 18).padEnd(18)} → ${r.to.slice(0, 22).padEnd(22)} ${r.outcome.padEnd(10)} ${r.detail}`);
      }
      const count = (x: Row["outcome"]) => rows.filter((r) => r.outcome === x).length;
      console.log(`\n${rows.length} invoice(s) flagged for a salesperson with no account: ${write ? `${count("moved")} moved` : `${count("would move")} would be moved`}, ${count("left")} left.`);
      if (undoFile) console.log(`Undo file: ${undoFile}`);
      if (!write) console.log(`Nothing written. To do it: bun src/scripts/crm-salesperson-backfill.ts --write --expect ${count("would move")}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  await mongoose.disconnect();
}
