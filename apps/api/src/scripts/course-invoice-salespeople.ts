/**
 * The invoices CS Portal course payments made, given to the person who raised the payment (the user, 2026-10-30: "why
 * is the salesperson super admin on these — change all of them to the CS Portal users").
 *
 * Until 2026-10-30 such an invoice (external.source "tetra-course") took the accountant who approved the payment as its
 * salesperson. For each one whose salesperson is still that approver, the request that made it names who raised it in
 * CS Portal (and its initiating mentor); they are found among this organization's accounts — payroll-only staff
 * accounts included — by email when CS Portal sent it (only newer requests have it), else by their exact name, else by
 * their CS Portal name being the part of an email before the @ (course-invoice-salesperson.ts, the same rule as new
 * invoices). Found: the invoice becomes theirs, and the "no account here" flag an earlier run put on it goes. Not
 * found: left on the approver, with that flag, and listed here. An invoice given to someone else since (by hand) is
 * left alone.
 *
 * Somebody finance has no account for at all (the user: "missing sales person need to create also"): name them with
 * --create "<their CS Portal name>=<email>" (as many times as needed) and a salesperson-only account is made for them
 * (nobody can sign in with it — Users → Salespeople makes it a real user), and their invoices become theirs.
 *
 * Reads and prints only, unless --write; --write first saves what it changes to an undo file (--undo <file> puts the
 * salespeople back, and removes an account it made while no invoice is on it). Run it from apps/api on the server
 * (Bun reads MONGODB_URI from the .env):
 *
 *   bun src/scripts/course-invoice-salespeople.ts                      # what it would do
 *   bun src/scripts/course-invoice-salespeople.ts --create "Glorita=glorita.s@example.com"
 *   bun src/scripts/course-invoice-salespeople.ts --write --expect N   # do it (N = the "would change" count shown)
 *   bun src/scripts/course-invoice-salespeople.ts --undo <file>        # put the saved salespeople back
 */
import mongoose, { Types } from "mongoose";
import { writeFileSync, readFileSync } from "node:fs";
import { TetraDepositModel } from "../modules/tetra-deposit/tetra-deposit.model";
import { COURSE_INVOICE_SOURCE } from "../modules/tetra-deposit/course-invoice";
import { courseSalesperson, createStaffSalesperson, NO_ACCOUNT_FLAG, staffAccount } from "../modules/tetra-deposit/course-invoice-salesperson";

export interface SalespersonRow {
  invoice: string; customer: string; from: string; to: string; raisedBy: string;
  outcome: "would change" | "changed" | "no account" | "flagged" | "reassigned by hand" | "no request";
}

/** "Glorita=glorita.s@example.com" → glorita → { name: "Glorita", email }. */
export function parseCreate(values: string[]): Map<string, { name: string; email: string }> {
  const out = new Map<string, { name: string; email: string }>();
  for (const v of values) {
    const i = v.lastIndexOf("=");
    const name = v.slice(0, i).trim();
    const email = v.slice(i + 1).trim().toLowerCase();
    if (i < 1 || !name || !/^\S+@\S+\.\S+$/.test(email)) throw new Error(`--create "${v}": write it as "<CS Portal name>=<email>"`);
    out.set(name.toLowerCase(), { name, email });
  }
  return out;
}

interface UndoFile { invoices: Array<{ _id: string; invoiceNumber?: string; salespersonId: string; salespersonName: string; flags: string[] }>; createdUsers: string[] }

export async function fixCourseInvoiceSalespeople(opts: {
  write: boolean; expect?: number; undoFile?: string; create?: Map<string, { name: string; email: string }>;
}): Promise<{ rows: SalespersonRow[]; undoFile?: string }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { User } = await import("../modules/user/user.model");
  const invoices = await Invoice.find({ "external.source": COURSE_INVOICE_SOURCE })
    .select("organizationId invoiceNumber customerName salespersonId salespersonName external issueDate")
    .sort({ issueDate: 1, invoiceNumber: 1 }).lean<any[]>();

  type Plan = { inv: any; to?: { id: string; name: string }; make?: { name: string; email: string }; flag?: string; row: SalespersonRow };
  const plans: Plan[] = [];
  for (const inv of invoices) {
    // The request that made it: the first one recorded on it.
    const req = await TetraDepositModel.findOne({ "courseInvoice.invoiceId": inv._id })
      .sort({ requestedAt: 1, createdAt: 1 })
      .select("requestedBy requestedByEmail initiatingMentor initiatingMentorEmail decision.decidedById decision.decidedByName").lean<any>();
    const base = { invoice: String(inv.invoiceNumber), customer: String(inv.customerName ?? ""), from: String(inv.salespersonName ?? ""), raisedBy: String(req?.requestedBy || req?.initiatingMentor || "") };
    if (!req) { plans.push({ inv, row: { ...base, to: "", outcome: "no request" } }); continue; }
    // Still the approver's, as the payment made it; another person's since means somebody chose them.
    const approverId = String(req.decision?.decidedById ?? "");
    if (approverId && String(inv.salespersonId) !== approverId) { plans.push({ inv, row: { ...base, to: "", outcome: "reassigned by hand" } }); continue; }
    const seller = await courseSalesperson(inv.organizationId, req, { id: String(inv.salespersonId), name: String(inv.salespersonName ?? "") });
    if (seller.by === "approver") {
      // Named with --create: their account (if one has that email by now), else one made for them.
      const named = [req.requestedBy, req.initiatingMentor].map((n) => opts.create?.get(String(n ?? "").trim().toLowerCase())).find(Boolean);
      if (named) {
        const found = await staffAccount(inv.organizationId, { email: named.email });
        if (found) {
          plans.push({ inv, to: { id: found.id, name: found.name }, row: { ...base, to: `${found.name} (by email)`, outcome: "would change" } });
          continue;
        }
        const other = await User.exists({ email: named.email });
        if (!other) {
          plans.push({ inv, make: named, row: { ...base, to: `${named.name} (new account ${named.email})`, outcome: "would change" } });
          continue;
        }
        plans.push({ inv, row: { ...base, to: `(${named.email} is another organization's)`, outcome: "no account" } });
        continue;
      }
      const flags: string[] = inv.external?.flags ?? [];
      const flag = seller.flag && !flags.includes(seller.flag) ? seller.flag : undefined;
      plans.push({ inv, flag, row: { ...base, to: "", outcome: "no account" } });
      continue;
    }
    if (seller.id === String(inv.salespersonId)) continue; // already theirs
    plans.push({ inv, to: { id: seller.id, name: seller.name }, row: { ...base, to: `${seller.name} (by ${seller.by})`, outcome: "would change" } });
  }

  const changing = plans.filter((p) => p.to || p.make);
  if (!opts.write) return { rows: plans.map((p) => p.row) };
  if (opts.expect !== undefined && opts.expect !== changing.length) {
    throw new Error(`--expect ${opts.expect}, but ${changing.length} would change now — run it again without --write and check`);
  }

  // Saved before anything changes, and read back whole; the accounts made are added as they are made.
  const undo: UndoFile = {
    invoices: plans.filter((p) => p.to || p.make || p.flag).map((p) => ({
      _id: String(p.inv._id), invoiceNumber: p.inv.invoiceNumber, salespersonId: String(p.inv.salespersonId),
      salespersonName: p.inv.salespersonName ?? "", flags: p.inv.external?.flags ?? [],
    })),
    createdUsers: [],
  };
  const undoFile = opts.undoFile ?? `course-invoice-salespeople-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const save = () => {
    writeFileSync(undoFile, JSON.stringify(undo, null, 2));
    const back = JSON.parse(readFileSync(undoFile, "utf8")) as UndoFile;
    if (back.invoices.length !== undo.invoices.length || back.createdUsers.length !== undo.createdUsers.length) throw new Error(`The undo file ${undoFile} didn't read back whole — stopped`);
  };
  save();

  const made = new Map<string, { id: string; name: string }>();
  for (const p of plans) {
    if (p.make) {
      const key = `${p.inv.organizationId}:${p.make.email}`;
      let to = made.get(key);
      if (!to) {
        const r = await createStaffSalesperson(p.inv.organizationId, p.make);
        if (!r) { p.row.outcome = "no account"; p.row.to = `(${p.make.email} is another organization's)`; continue; }
        to = { id: r.id, name: r.name };
        made.set(key, to);
        if (r.created) { undo.createdUsers.push(r.id); save(); }
      }
      p.to = to;
    }
    if (p.to) {
      await Invoice.updateOne({ _id: p.inv._id }, {
        $set: { salespersonId: new Types.ObjectId(p.to.id), salespersonName: p.to.name },
        $pull: { "external.flags": NO_ACCOUNT_FLAG },
      });
      p.row.outcome = "changed";
    } else if (p.flag) {
      await Invoice.updateOne({ _id: p.inv._id }, { $addToSet: { "external.flags": p.flag } });
      p.row.outcome = "flagged";
    }
  }
  return { rows: plans.map((p) => p.row), undoFile };
}

/**
 * Puts back the salespeople and flags an undo file saved (either kind: the first runs saved just the list of
 * invoices), then removes each account the run made — unless an invoice is on it, or it has been given more since.
 */
export async function undoCourseInvoiceSalespeople(file: string): Promise<{ invoices: number; removed: number; kept: string[] }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { User } = await import("../modules/user/user.model");
  const raw = JSON.parse(readFileSync(file, "utf8")) as UndoFile | UndoFile["invoices"];
  const saved: UndoFile = Array.isArray(raw) ? { invoices: raw, createdUsers: [] } : raw;
  for (const s of saved.invoices) {
    await Invoice.updateOne({ _id: new Types.ObjectId(s._id) }, {
      $set: { salespersonId: new Types.ObjectId(s.salespersonId), salespersonName: s.salespersonName, "external.flags": s.flags },
    });
  }
  let removed = 0;
  const kept: string[] = [];
  for (const id of saved.createdUsers) {
    const u = await User.findById(id).select("name email memberships").lean<any>();
    if (!u) continue;
    const onInvoices = await Invoice.countDocuments({ salespersonId: u._id });
    if (onInvoices || (u.memberships ?? []).length !== 1) { kept.push(`${u.name} (${u.email})`); continue; }
    await User.deleteOne({ _id: u._id });
    removed++;
  }
  return { invoices: saved.invoices.length, removed, kept };
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? String(process.argv[i + 1] ?? "") : ""; };
  const args = (name: string) => process.argv.flatMap((v, i) => (process.argv[i - 1] === name ? [v] : []));
  const create = parseCreate(args("--create"));
  const { connectDb } = await import("../config/db");
  await connectDb();
  if (arg("--undo")) {
    const r = await undoCourseInvoiceSalespeople(arg("--undo"));
    console.log(`Put back ${r.invoices} invoice(s) from ${arg("--undo")}; removed ${r.removed} account(s) it made.${r.kept.length ? ` Kept (in use now): ${r.kept.join(", ")}.` : ""}`);
  } else {
    const write = process.argv.includes("--write");
    const expect = arg("--expect") ? Number(arg("--expect")) : undefined;
    const { rows, undoFile } = await fixCourseInvoiceSalespeople({ write, expect, create });
    for (const r of rows) console.log(`${r.invoice.padEnd(12)} ${r.customer.slice(0, 26).padEnd(26)} ${r.from.slice(0, 16).padEnd(16)} → ${(r.to || "—").slice(0, 52).padEnd(52)} ${r.outcome}${r.raisedBy ? ` (raised by ${r.raisedBy})` : ""}`);
    const count = (o: string) => rows.filter((r) => r.outcome === o).length;
    console.log(`\n${rows.length} CS Portal course invoice(s): ${write ? `${count("changed")} changed, ${count("flagged")} flagged` : `${count("would change")} would change`}, ${count("no account") + count("flagged")} with nobody to give them to, ${count("reassigned by hand")} reassigned by hand, ${count("no request")} with no request.`);
    if (undoFile) console.log(`Undo file: ${undoFile}`);
    const again = [...create.values()].map((c) => ` --create "${c.name}=${c.email}"`).join("");
    if (!write) console.log(`Nothing written. To do it: bun src/scripts/course-invoice-salespeople.ts${again} --write --expect ${count("would change")}`);
  }
  await mongoose.disconnect();
}
