/**
 * Tetra Commission told, for every student already sent there, what the
 * counsellor collected and each payment's receipt (the owner, 2026-10-12).
 *
 * From 2026-10-12 the fee update Tetra Commission is sent (whenever an
 * enrolment's money changes) and the student's fee summary carry the close as
 * the counsellor declared it — "Collected by counsellor", how, each declared
 * payment with the salesperson's receipt, and the close's receipt
 * (modules/integrations/declared-side.ts). Students sent before that have none
 * of it there, which is why their receipts don't show on MT5 Approvals. This
 * queues one fee update for each of them — the whole picture, as now — and the
 * running API's worker sends them within the minute.
 *
 * Reads and prints only, unless --write. Run it from apps/api on the server
 * (Bun reads the .env there; COMMISSION_* must be set for the updates to be
 * queued). Tetra Commission must be on the version that reads these fields
 * first — an older one ignores them, harmlessly.
 *
 *   cd apps/api
 *   bun src/scripts/declared-receipts-backfill.ts                     # what it would send
 *   bun src/scripts/declared-receipts-backfill.ts --invoice IN-00124  # just one
 *   bun src/scripts/declared-receipts-backfill.ts --write             # queue them
 *   bun src/scripts/declared-receipts-backfill.ts --not-sent          # also the approved enrolments finance never
 *                                                                     # sent (students Tetra Commission had already)
 *
 * Safe to run again: each run queues the invoice's current picture, and Tetra
 * Commission keeps only the newest.
 *
 * Since 2026-10-27 that picture carries each recorded payment's receipt too (a
 * second payment's never reached Tetra Commission) — run it again once both
 * servers are on that version, and they arrive for the payments before it.
 */
import mongoose, { Types } from "mongoose";
import { formatMoney } from "@delta/shared";
import { Invoice } from "../modules/invoice/invoice.model";
import { LmsProvision } from "../modules/integrations/lms-provision.model";
import { commissionConfigured } from "../lib/commission-client";
import { queueFeeUpdate } from "../modules/integrations/commission-fee-update.service";
import { declaredSide } from "../modules/integrations/declared-side";

export interface DeclaredRow {
  /** Finance never sent this student (--not-sent): Tetra Commission may or may not have the invoice. */
  notSent?: boolean;
  invoiceNumber: string;
  customerName: string;
  collected: string;
  receipts: number;
  queued?: boolean;
}

export async function backfillDeclaredReceipts(opts: { write: boolean; invoices?: string[]; notSent?: boolean }): Promise<DeclaredRow[]> {
  const only = new Set((opts.invoices ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean));
  // Every enrolment whose student went to Tetra Commission.
  const provisions = await LmsProvision.find({ "commission.state": "sent" }).select("invoiceId").lean<{ invoiceId: Types.ObjectId }[]>();
  const ids = [...new Set(provisions.map((p) => String(p.invoiceId)))].map((id) => new Types.ObjectId(id));
  const sentIds = new Set(ids.map(String));
  // --not-sent: every approved enrolment too (2026-10-12) — Tetra Commission may hold its course fee from before
  // finance sent students (an older sale its CS logged a call on); it takes the update by the invoice, or says it
  // doesn't know it.
  const invoices = await Invoice.find(opts.notSent
    ? { $or: [{ _id: { $in: ids } }, { "approval.state": "approved", "enrolment.course": { $nin: [null, ""] }, status: { $ne: "void" } }] }
    : { _id: { $in: ids } }).sort({ issueDate: 1 }).lean<any[]>();
  const out: DeclaredRow[] = [];
  for (const invoice of invoices) {
    if (only.size && !only.has(String(invoice.invoiceNumber).toUpperCase())) continue;
    const d = declaredSide(invoice);
    const row: DeclaredRow = {
      ...(sentIds.has(String(invoice._id)) ? {} : { notSent: true }),
      invoiceNumber: invoice.invoiceNumber ?? "",
      customerName: invoice.customerName ?? "",
      collected: d.declaredPaidMinor ? `${formatMoney(d.declaredPaidMinor, invoice.currency ?? "AED")}${d.declaredPaymentMethod ? ` · ${d.declaredPaymentMethod}` : ""}` : "nothing declared",
      // Each file once: the close's receipt is often the declared payment's and the recorded payment's too.
      receipts: new Set([
        ...d.declaredPayments.map((p) => p.receipt?.url ?? ""), d.receipt?.url ?? "",
        ...(invoice.payments ?? []).map((p: { proofUrl?: string }) => String(p.proofUrl ?? "")),
      ].filter((u) => /^https?:\/\//i.test(u))).size,
    };
    if (opts.write) row.queued = await queueFeeUpdate(invoice._id, "collected by counsellor and receipts backfill", { evenIfNotSent: !sentIds.has(String(invoice._id)) });
    out.push(row);
  }
  return out;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const invoices = process.argv.reduce<string[]>((acc, a, i) => (a === "--invoice" && process.argv[i + 1] ? [...acc, process.argv[i + 1]!] : acc), []);
  const { connectDb } = await import("../config/db");
  await connectDb();
  console.log(`Tetra Commission link: ${commissionConfigured() ? "configured" : "NOT CONFIGURED — nothing can be queued"}`);
  const rows = await backfillDeclaredReceipts({ write, invoices, notSent: process.argv.includes("--not-sent") });
  for (const r of rows) {
    console.log(`${r.notSent ? "* " : "  "}${r.invoiceNumber.padEnd(12)} ${r.customerName.slice(0, 28).padEnd(28)} collected ${r.collected.padEnd(24)} receipts ${r.receipts}${write ? (r.queued ? "  · queued" : "  · NOT queued") : ""}`);
  }
  if (rows.some((r) => r.notSent)) console.log("\n* never sent by finance — Tetra Commission takes it if it has this invoice's course fee (an older student), else says it doesn't know it (harmless)");
  console.log(`\n${rows.length} enrolment${rows.length === 1 ? "" : "s"} ${write ? "queued for Tetra Commission" : "would be sent"}${write ? "" : " — nothing queued. Run again with --write to send them."}`);
  await mongoose.disconnect();
}
