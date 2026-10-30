/**
 * A CS Portal bonus's course payment approved with the wrong amount, put right here (the user, 2026-10-30: Vinod,
 * STU-4900, MSNR — "6000 paid", not the AED 5,505 the request carried). Two things change:
 *
 *   - the Tetra deposit: the AED typed (amountOriginal), its USD at 3.67 (amountMinor, and the approved amount),
 *     the course payment's paid now / balance left (moved by the same difference), its one payment, and the payment it
 *     became on the invoice (courseInvoice.amountMinor) — with an event saying so;
 *   - the payment on the invoice, through invoice.service updatePayment, as Edit payment on the invoice does: the
 *     invoice's paid, balance and status follow, its bank line and LMS access, and CS Portal is told the course's
 *     new figures if it has the invoice (the fee update queue). Its date, method, account and receipt number stay;
 *     no receipt is emailed.
 *
 * The MT5 bonus is not changed. CS Portal's own funding request is put right with its script
 * (commission portal backend/src/scripts/fix-course-payment-amount.ts).
 *
 * Reads and prints only, unless --write (a copy of both before is saved in backups/ first). From apps/api:
 *
 *   bun src/scripts/fix-course-payment-amount.ts --code STU-4900 --product MSNR --aed 6000 --by <your finance email>
 *   bun src/scripts/fix-course-payment-amount.ts --code STU-4900 --product MSNR --aed 6000 --by <email> --write
 *   bun src/scripts/fix-course-payment-amount.ts --undo backups/<file> --write
 * Two deposits match → it lists them; add --id <one of them>.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import mongoose from "mongoose";
import { formatMoney } from "@delta/shared";
import { TetraDepositModel } from "../modules/tetra-deposit/tetra-deposit.model";
import { Invoice } from "../modules/invoice/invoice.model";
import { updatePayment } from "../modules/invoice/invoice.service";
import { User } from "../modules/user/user.model";

const AED_PER_USD = 3.67;
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? "" : ""; };
const write = args.includes("--write");
const money = (minor: number, cur = "AED") => formatMoney(minor, cur);

await mongoose.connect(process.env.MONGODB_URI!);
console.log(`Database: ${mongoose.connection.host} / ${mongoose.connection.name}${write ? "" : "   (showing only — add --write to change it)"}\n`);

/** The payment as updatePayment takes it, with a new amount and everything else as it is. */
const paymentInput = (p: any, amountMinor: number) => ({
  method: p.method, amountMinor, paidOn: new Date(p.paidOn).toISOString(),
  reference: p.reference ?? "", notes: p.notes ?? "", accountName: p.accountName ?? "", chargesMinor: p.chargesMinor ?? 0,
});

/** Edit payment on the invoice; when it fails after saving (the payment has the amount), carries on. */
async function setPayment(orgId: string, invoiceId: string, p: any, amountMinor: number) {
  try {
    await updatePayment(orgId, invoiceId, String(p._id), paymentInput(p, amountMinor));
  } catch (err) {
    const now = (await Invoice.findById(invoiceId).lean<any>())?.payments?.find((x: any) => String(x._id) === String(p._id));
    if (now?.amountMinor !== amountMinor) throw err;
    console.warn(`(The invoice was saved; afterwards: ${err instanceof Error ? err.message : String(err)})`);
  }
}

try {
  const undo = flag("--undo");
  if (undo) {
    const saved = JSON.parse(readFileSync(undo, "utf8"));
    console.log(`From ${undo}: deposit ${saved.id} and its payment back to ${money(saved.payment?.amountMinor ?? 0)}`);
    if (write) {
      if (saved.payment) await setPayment(saved.organizationId, saved.invoiceId, saved.payment, saved.payment.amountMinor);
      // Only what the change set, back as it was; the event saying so goes too.
      await TetraDepositModel.updateOne({ _id: saved.id }, { $set: saved.fields, $pull: { events: { kind: "amount_corrected", at: new Date(saved.at) } } });
      console.log("Put back.");
    }
    process.exit(0);
  }

  const code = flag("--code").trim().toUpperCase(), product = flag("--product").trim().toUpperCase();
  const newAed = Number(flag("--aed")), by = flag("--by").trim().toLowerCase(), pick = flag("--id").trim();
  if (!code || !product || !(newAed > 0) || !by) {
    console.error("Usage: bun src/scripts/fix-course-payment-amount.ts --code <STU code> --product <course> --aed <AED paid> --by <email> [--id <deposit id>] [--write]");
    process.exit(1);
  }
  const user = await User.findOne({ email: by }).select("name email").lean<any>();
  if (!user) { console.error(`No finance user ${by}`); process.exit(1); }

  const found = await TetraDepositModel.find({
    "student.code": code, type: "BONUS", "coursePayment.product": { $regex: `^${product}$`, $options: "i" },
    status: { $nin: ["rejected", "deleted"] }, ...(/^[a-f0-9]{24}$/.test(pick) ? { _id: pick } : {}),
  }).lean<any[]>();
  if (found.length !== 1) {
    console.error(found.length ? `${found.length} ${product} course payments for ${code} — add --id <one of these>:` : `No ${product} course payment for ${code} — nothing done.`);
    for (const d of found) console.error(`  ${d._id} · ${d.status} · ${d.amountCurrency ?? ""} ${d.amountOriginal ?? ""} · ${d.requestedAt?.toISOString?.() ?? "—"}`);
    process.exit(1);
  }
  const d = found[0], cp = d.coursePayment ?? {};
  if (d.currency !== "USD" || (d.amountCurrency && d.amountCurrency !== "AED")) { console.error(`It is in ${d.amountCurrency || d.currency} — only AED course payments are handled here; nothing done.`); process.exit(1); }
  if ((d.payments?.length ?? 0) > 1) { console.error(`It was paid ${d.payments.length} ways — not handled here; nothing done.`); process.exit(1); }

  const oldAed = Number(cp.paidTodayAed) || Number(d.amountOriginal) || 0;
  const diff = Math.round((newAed - oldAed) * 100) / 100;
  const newUsdMinor = Math.round((newAed / AED_PER_USD) * 100);
  const newAedMinor = Math.round(newAed * 100);

  console.log(`Tetra deposit ${d._id} · ${d.status} · ${d.student?.name} (${code}) · ${cp.product} ${cp.kind} · MT5 bonus USD ${cp.bonusUsd ?? "—"} (unchanged)`);
  console.log(`  paid now  AED ${oldAed} → AED ${newAed}`);
  if (cp.balanceAed != null) console.log(`  balance   AED ${cp.balanceAed} → AED ${Math.max(0, cp.balanceAed - diff)}`);
  console.log(`  amount    ${money(d.decision?.approvedAmountMinor ?? d.amountMinor, "USD")} → ${money(newUsdMinor, "USD")} (at ${AED_PER_USD})`);

  // The payment it became on the invoice.
  let inv: any = null, payment: any = null;
  if (d.courseInvoice?.invoiceId && d.courseInvoice?.paymentId) {
    inv = await Invoice.findById(d.courseInvoice.invoiceId).lean<any>();
    payment = inv?.payments?.find((p: any) => String(p._id) === String(d.courseInvoice.paymentId)) ?? null;
    if (!inv || !payment) { console.error(`\nIts payment ${d.courseInvoice.receiptNumber} on ${d.courseInvoice.invoiceNumber} is not there any more — nothing done.`); process.exit(1); }
    if ((inv.currency ?? "AED") !== "AED") { console.error(`\nIts invoice is in ${inv.currency} — not handled here; nothing done.`); process.exit(1); }
    if (payment.bankAmountMinor != null && payment.bankAmountMinor !== payment.amountMinor) { console.error(`\nIts payment landed in another currency's account — change it on the invoice instead; nothing done.`); process.exit(1); }
    const paidAfter = (inv.amountPaidMinor ?? 0) - payment.amountMinor + newAedMinor;
    console.log(`\nInvoice ${inv.invoiceNumber} (total ${money(inv.totalMinor)}) · payment ${d.courseInvoice.receiptNumber || payment.receiptNumber || payment._id}`);
    console.log(`  payment   ${money(payment.amountMinor)} → ${money(newAedMinor)}`);
    console.log(`  paid      ${money(inv.amountPaidMinor ?? 0)} → ${money(paidAfter)}`);
    console.log(`  balance   ${money(inv.balanceMinor ?? 0)} → ${money((inv.totalMinor ?? 0) - paidAfter)}`);
    if (paidAfter > (inv.totalMinor ?? 0)) { console.error("\nThat would be more than the invoice's total — nothing done."); process.exit(1); }
  } else {
    console.log("\nNo invoice payment made from it yet — only the deposit changes.");
  }
  if (!diff) { console.log("\nAlready that amount — nothing to do."); process.exit(0); }

  if (write) {
    mkdirSync("backups", { recursive: true });
    const file = `backups/fix-course-payment-${d._id}-${Date.now()}.json`;
    const at = new Date();
    // What the change sets, as it is now — the undo puts these back.
    const before: Record<string, unknown> = {
      amountOriginal: d.amountOriginal, amountMinor: d.amountMinor, "coursePayment.paidTodayAed": cp.paidTodayAed,
      ...(cp.balanceAed != null ? { "coursePayment.balanceAed": cp.balanceAed } : {}),
      ...(d.decision?.approvedAmountMinor != null ? { "decision.approvedAmountMinor": d.decision.approvedAmountMinor } : {}),
      ...(d.payments?.length === 1 ? { "payments.0.amountMinor": d.payments[0].amountMinor } : {}),
      ...(payment ? { "courseInvoice.amountMinor": d.courseInvoice.amountMinor } : {}),
    };
    writeFileSync(file, JSON.stringify({ id: String(d._id), organizationId: String(d.organizationId), invoiceId: inv ? String(inv._id) : "", at, fields: before, payment, deposit: d }, null, 2));
    console.log(`\nUndo file: ${file}`);

    if (payment) await setPayment(String(d.organizationId), String(inv._id), payment, newAedMinor);
    const set: Record<string, unknown> = {
      amountOriginal: newAed, amountMinor: newUsdMinor, "coursePayment.paidTodayAed": newAed,
      ...(cp.balanceAed != null ? { "coursePayment.balanceAed": Math.max(0, cp.balanceAed - diff) } : {}),
      ...(d.decision?.approvedAmountMinor != null ? { "decision.approvedAmountMinor": newUsdMinor } : {}),
      ...(d.payments?.length === 1 ? { "payments.0.amountMinor": d.payments[0].currency === "AED" ? newAedMinor : newUsdMinor } : {}),
      ...(payment ? { "courseInvoice.amountMinor": newAedMinor } : {}),
    };
    await TetraDepositModel.updateOne({ _id: d._id }, {
      $set: set,
      $push: { events: { at, kind: "amount_corrected", byName: user.name, text: `Amount paid corrected from AED ${oldAed} to AED ${newAed} (script)` } },
    });
    console.log("Changed. (CS Portal is sent the invoice's new figures only if it has this invoice as a course fee.)");
  }
} finally {
  await mongoose.disconnect();
}
