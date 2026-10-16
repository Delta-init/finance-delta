/**
 * Course payment receipts sent again (2026-10-16: the Bangalore move's RCT-00001 and RCT-00002 were cut off when the
 * script closed the database before their emails went).
 *
 * For each receipt named in that organization: skipped when the email log shows it went (--force sends it anyway),
 * else emailed to the student as the original would have been.
 *
 *   cd apps/api
 *   bun src/scripts/resend-course-receipts.ts --org <id> --receipts RCT-00001,RCT-00002            # what it would do
 *   bun src/scripts/resend-course-receipts.ts --org <id> --receipts RCT-00001,RCT-00002 --write    # send
 */
import mongoose, { Types } from "mongoose";
import { TetraDepositModel } from "../modules/tetra-deposit/tetra-deposit.model";
import { Invoice } from "../modules/invoice/invoice.model";
import { resendCourseReceipt, settleCourseReceiptEmails } from "../modules/tetra-deposit/course-invoice";

if (import.meta.main) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > -1 ? String(process.argv[i + 1] ?? "") : ""; };
  const orgId = arg("--org");
  const receipts = arg("--receipts").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!Types.ObjectId.isValid(orgId) || !receipts.length) {
    console.error("--org <organization id> and --receipts RCT-…[,RCT-…] are required");
    process.exit(1);
  }
  const write = process.argv.includes("--write");
  const force = process.argv.includes("--force");
  const { connectDb } = await import("../config/db");
  await connectDb();
  const rows = await TetraDepositModel.find({ "courseInvoice.receiptNumber": { $in: receipts } }).lean<any[]>();
  for (const r of rows) {
    const inv = await Invoice.findById(r.courseInvoice.invoiceId).select("organizationId invoiceNumber").lean<any>();
    if (String(inv?.organizationId) !== orgId) continue;
    const who = `${r.courseInvoice.receiptNumber} · ${inv.invoiceNumber} · ${r.student?.name ?? ""} <${r.student?.email ?? "no email"}>`;
    if (!write) { console.log(`${who} — would be sent${force ? " (forced)" : " unless the log shows it went"}`); continue; }
    console.log(`${who} — ${await resendCourseReceipt(String(r._id), { force })}`);
  }
  if (!write) console.log("\nNothing sent. Run again with --write to send.");
  await settleCourseReceiptEmails();
  await mongoose.disconnect();
}
