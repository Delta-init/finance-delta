/**
 * The invoices CS Portal course payments made, given to the person who raised the payment (the user, 2026-10-30: "why
 * is the salesperson super admin on these — change all of them to the CS Portal users").
 *
 * Until 2026-10-30 such an invoice (external.source "tetra-course") took the accountant who approved the payment as its
 * salesperson. For each one whose salesperson is still that approver, the request that made it names who raised it in
 * CS Portal (and its initiating mentor); they are found among this organization's accounts — payroll-only staff
 * accounts included — by email when CS Portal sent it (only newer requests have it), else by their exact name
 * (course-invoice-salesperson.ts, the same rule as new invoices). Found: the invoice becomes theirs. Not found: left on
 * the approver, with a flag on the invoice to reassign it, and listed here. An invoice given to someone else since
 * (by hand) is left alone.
 *
 * Reads and prints only, unless --write; --write first saves what it changes to an undo file (--undo <file> puts it
 * back). Run it from apps/api on the server (Bun reads MONGODB_URI from the .env):
 *
 *   bun src/scripts/course-invoice-salespeople.ts                      # what it would do
 *   bun src/scripts/course-invoice-salespeople.ts --write --expect N   # do it (N = the "would change" count shown)
 *   bun src/scripts/course-invoice-salespeople.ts --undo <file>        # put the saved salespeople back
 */
import mongoose, { Types } from "mongoose";
import { writeFileSync, readFileSync } from "node:fs";
import { TetraDepositModel } from "../modules/tetra-deposit/tetra-deposit.model";
import { COURSE_INVOICE_SOURCE } from "../modules/tetra-deposit/course-invoice";
import { courseSalesperson } from "../modules/tetra-deposit/course-invoice-salesperson";

export interface SalespersonRow {
  invoice: string; customer: string; from: string; to: string; raisedBy: string;
  outcome: "would change" | "changed" | "no account" | "flagged" | "reassigned by hand" | "no request";
}

export async function fixCourseInvoiceSalespeople(opts: { write: boolean; expect?: number; undoFile?: string }): Promise<{ rows: SalespersonRow[]; undoFile?: string }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const invoices = await Invoice.find({ "external.source": COURSE_INVOICE_SOURCE })
    .select("organizationId invoiceNumber customerName salespersonId salespersonName external issueDate")
    .sort({ issueDate: 1, invoiceNumber: 1 }).lean<any[]>();

  type Plan = { inv: any; to?: { id: string; name: string }; flag?: string; row: SalespersonRow };
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
      const flags: string[] = inv.external?.flags ?? [];
      const flag = seller.flag && !flags.includes(seller.flag) ? seller.flag : undefined;
      plans.push({ inv, flag, row: { ...base, to: "", outcome: "no account" } });
      continue;
    }
    if (seller.id === String(inv.salespersonId)) continue; // already theirs
    plans.push({ inv, to: { id: seller.id, name: seller.name }, row: { ...base, to: `${seller.name} (by ${seller.by})`, outcome: "would change" } });
  }

  const changing = plans.filter((p) => p.to);
  if (!opts.write) return { rows: plans.map((p) => p.row) };
  if (opts.expect !== undefined && opts.expect !== changing.length) {
    throw new Error(`--expect ${opts.expect}, but ${changing.length} would change now — run it again without --write and check`);
  }

  // Saved before anything changes, and read back whole.
  const undo = plans.filter((p) => p.to || p.flag).map((p) => ({
    _id: String(p.inv._id), invoiceNumber: p.inv.invoiceNumber, salespersonId: String(p.inv.salespersonId),
    salespersonName: p.inv.salespersonName ?? "", flags: p.inv.external?.flags ?? [],
  }));
  const undoFile = opts.undoFile ?? `course-invoice-salespeople-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(undoFile, JSON.stringify(undo, null, 2));
  if ((JSON.parse(readFileSync(undoFile, "utf8")) as unknown[]).length !== undo.length) throw new Error(`The undo file ${undoFile} didn't read back whole — nothing changed`);

  for (const p of plans) {
    if (p.to) {
      await Invoice.updateOne({ _id: p.inv._id }, { $set: { salespersonId: new Types.ObjectId(p.to.id), salespersonName: p.to.name } });
      p.row.outcome = "changed";
    } else if (p.flag) {
      await Invoice.updateOne({ _id: p.inv._id }, { $addToSet: { "external.flags": p.flag } });
      p.row.outcome = "flagged";
    }
  }
  return { rows: plans.map((p) => p.row), undoFile };
}

/** Puts back the salespeople and flags an undo file saved. */
export async function undoCourseInvoiceSalespeople(file: string): Promise<number> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const saved = JSON.parse(readFileSync(file, "utf8")) as Array<{ _id: string; salespersonId: string; salespersonName: string; flags: string[] }>;
  for (const s of saved) {
    await Invoice.updateOne({ _id: new Types.ObjectId(s._id) }, {
      $set: { salespersonId: new Types.ObjectId(s.salespersonId), salespersonName: s.salespersonName, "external.flags": s.flags },
    });
  }
  return saved.length;
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? String(process.argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  if (arg("--undo")) {
    console.log(`Put back ${await undoCourseInvoiceSalespeople(arg("--undo"))} invoice(s) from ${arg("--undo")}.`);
  } else {
    const write = process.argv.includes("--write");
    const expect = arg("--expect") ? Number(arg("--expect")) : undefined;
    const { rows, undoFile } = await fixCourseInvoiceSalespeople({ write, expect });
    for (const r of rows) console.log(`${r.invoice.padEnd(12)} ${r.customer.slice(0, 26).padEnd(26)} ${r.from.slice(0, 16).padEnd(16)} → ${(r.to || "—").slice(0, 34).padEnd(34)} ${r.outcome}${r.raisedBy ? ` (raised by ${r.raisedBy})` : ""}`);
    const count = (o: string) => rows.filter((r) => r.outcome === o).length;
    console.log(`\n${rows.length} CS Portal course invoice(s): ${write ? `${count("changed")} changed, ${count("flagged")} flagged` : `${count("would change")} would change`}, ${count("no account") + count("flagged")} with nobody to give them to, ${count("reassigned by hand")} reassigned by hand.`);
    if (undoFile) console.log(`Undo file: ${undoFile}`);
    if (!write) console.log(`Nothing written. To do it: bun src/scripts/course-invoice-salespeople.ts --write --expect ${count("would change")}`);
  }
  await mongoose.disconnect();
}
