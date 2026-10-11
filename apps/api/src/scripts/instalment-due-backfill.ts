/**
 * Existing partial Forex enrolments: their next due date by the 29-day rule,
 * and Tetra Commission told (the user, 2026-10-11).
 *
 * From 2026-10-11 a part-paid CRM enrolment's due date is its latest payment's
 * paidOn + 29 days, set at approval and whenever a payment changes
 * (modules/invoice/instalments.ts). Enrolments approved before that still carry
 * the close date as their due date — which is why they read "overdue" the day
 * after the close. This sets theirs by the same rule and queues the fee update
 * for those whose student went to Tetra Commission, so the CS's Balance
 * payments page shows the right date.
 *
 * Forex only — the enrolments the LMS named 4x-trading, or whose student went
 * to Tetra Commission — like the reminders.
 *
 * Reads and prints only, unless --write. Run it from apps/api on the server
 * (Bun reads the .env there; COMMISSION_* must be set there for the updates to
 * be queued, and the running API's worker sends them within the minute):
 *
 *   cd apps/api
 *   bun src/scripts/instalment-due-backfill.ts                 # what it would do
 *   bun src/scripts/instalment-due-backfill.ts --invoice IN-00086
 *   bun src/scripts/instalment-due-backfill.ts --write         # do it
 *
 * Safe to run again: an invoice already on the rule's date is left alone (and
 * not queued again).
 */
import mongoose, { Types } from "mongoose";
import { formatMoney } from "@delta/shared";
import { Invoice } from "../modules/invoice/invoice.model";
import { LmsProvision, isForexEnrolment } from "../modules/integrations/lms-provision.model";
import { isoDay, nextInstalmentDue } from "../modules/invoice/instalments";
import { commissionConfigured } from "../lib/commission-client";
import { queueFeeUpdate } from "../modules/integrations/commission-fee-update.service";

const CRM_SOURCES = ["crm", "draw-crm", "banglore-crm"];

export interface BackfillRow {
  invoiceNumber: string;
  customerName: string;
  balance: string;
  from: string;
  to: string;
  toCommission: boolean;
  queued?: boolean;
}

export async function backfillInstalmentDue(opts: { write: boolean; invoices?: string[] }): Promise<BackfillRow[]> {
  const only = new Set((opts.invoices ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean));
  const invoices = await Invoice.find({
    status: { $ne: "void" },
    balanceMinor: { $gt: 0 },
    amountPaidMinor: { $gt: 0 },
    "approval.state": "approved",
    $or: [{ "external.source": { $in: CRM_SOURCES } }, { "enrolment.course": { $nin: [null, ""] } }],
  }).sort({ issueDate: 1 }).lean<any[]>();
  const scoped = invoices.filter((i) => !only.size || only.has(String(i.invoiceNumber).toUpperCase()));
  const provisions = await LmsProvision.find({ invoiceId: { $in: scoped.map((i) => i._id) } })
    .select("invoiceId lmsCourseProgram commission.state")
    .lean<{ invoiceId: Types.ObjectId; lmsCourseProgram?: string; commission?: { state?: string } }[]>();
  const byInvoice = new Map(provisions.map((p) => [String(p.invoiceId), p]));

  const out: BackfillRow[] = [];
  for (const invoice of scoped) {
    const provision = byInvoice.get(String(invoice._id));
    if (!isForexEnrolment(provision)) continue;
    const due = nextInstalmentDue(invoice);
    if (!due) continue;
    const from = invoice.dueDate ? isoDay(new Date(invoice.dueDate)) : "";
    const to = isoDay(due);
    if (from === to) continue;
    const row: BackfillRow = {
      invoiceNumber: invoice.invoiceNumber,
      customerName: invoice.customerName,
      balance: formatMoney(invoice.balanceMinor ?? 0, invoice.currency ?? "AED"),
      from,
      to,
      toCommission: provision?.commission?.state === "sent",
    };
    if (opts.write) {
      // Only if nobody moved it meanwhile.
      const done = await Invoice.updateOne({ _id: invoice._id, dueDate: invoice.dueDate }, { $set: { dueDate: due } });
      if (done.modifiedCount && row.toCommission) row.queued = await queueFeeUpdate(invoice._id, "due date backfill");
    }
    out.push(row);
  }
  return out;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const invoices = process.argv.reduce<string[]>((acc, a, i) => (a === "--invoice" && process.argv[i + 1] ? [...acc, process.argv[i + 1]!] : acc), []);
  const { connectDb } = await import("../config/db");
  await connectDb();
  console.log(`Tetra Commission link: ${commissionConfigured() ? "configured" : "NOT CONFIGURED — due dates change, but Tetra Commission is not told"}`);
  const rows = await backfillInstalmentDue({ write, invoices });
  for (const r of rows) {
    console.log(`${r.invoiceNumber.padEnd(12)} ${r.customerName.slice(0, 28).padEnd(28)} balance ${r.balance.padStart(14)}  due ${r.from || "—"} → ${r.to}${r.toCommission ? (write ? (r.queued ? "  · Tetra Commission update queued" : "  · Tetra Commission NOT queued") : "  · Tetra Commission would be told") : ""}`);
  }
  console.log(`\n${rows.length} partial Forex enrolment${rows.length === 1 ? "" : "s"} ${write ? "updated" : "would change"}${write ? "" : " — nothing written. Run again with --write to do it."}`);
  await mongoose.disconnect();
}
