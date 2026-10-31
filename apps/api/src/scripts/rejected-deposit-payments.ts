/**
 * Payments still on an invoice for a CS Portal request finance itself no longer approves (the user, 2026-10-31: one
 * approved, reopened and rejected kept its payment on the invoice, so Collected counted money nobody approved).
 *
 * Since 2026-10-31 a reopen takes the payment off (tetra-deposit.service.ts reopenTetraDeposit), and a rejection in
 * CS Portal does too (withdrawTetraDeposit). This puts right the ones from before: every request here that is
 * rejected, closed or deleted whose payment (externalRef tetra:<request id>) is still on an invoice has it taken off,
 * as Delete payment on the invoice does — the balance, the bank line, CS Portal's fee update. One whose bank line was
 * reconciled is listed and left.
 *
 * Reads and prints only, unless --write; --write first saves what it takes off to an undo file (--undo <file> records
 * those payments again, receipt numbers too). Run it from apps/api on the server (Bun reads MONGODB_URI from the .env):
 *
 *   bun src/scripts/rejected-deposit-payments.ts                    # what it would do
 *   bun src/scripts/rejected-deposit-payments.ts --write --expect N # do it (N = the "would take off" count shown)
 *   bun src/scripts/rejected-deposit-payments.ts --undo <file>      # put them back
 */
import mongoose, { Types } from "mongoose";
import { writeFileSync, readFileSync } from "node:fs";
import { TetraDepositModel } from "../modules/tetra-deposit/tetra-deposit.model";
import { takeOffRecordedPayments } from "../modules/tetra-deposit/tetra-deposit.service";

export interface LeftRow {
  depositId: string; externalId: string; status: string; student: string; invoice: string; receipt: string;
  amount: string; outcome: "would take off" | "taken off" | "kept (reconciled)";
}

const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export async function rejectedDepositPayments(opts: { write: boolean; expect?: number }): Promise<{ rows: LeftRow[]; undoFile?: string }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  // Every payment that came from a CS Portal request, and the requests they came from.
  const invoices = await Invoice.find({ status: { $ne: "void" }, "payments.externalRef": /^tetra:/ }).select("organizationId invoiceNumber currency payments").lean<any[]>();
  const held = invoices.flatMap((inv) => (inv.payments ?? []).filter((p: any) => /^tetra:[a-f0-9]{24}$/i.test(String(p.externalRef ?? "")))
    .map((p: any) => ({ inv, p, externalId: String(p.externalRef).slice(6) })));
  const deposits = await TetraDepositModel.find({ externalId: { $in: [...new Set(held.map((h) => h.externalId))] }, status: { $in: ["rejected", "closed", "deleted"] } }).lean<any[]>();
  const byKey = new Map(deposits.map((d) => [`${d.organizationId}:${d.externalId}`, d]));
  const left = held.filter((h) => byKey.has(`${h.inv.organizationId}:${h.externalId}`));

  if (opts.write && opts.expect !== undefined && opts.expect !== left.length) {
    throw new Error(`Expected ${opts.expect} to take off, found ${left.length} — nothing written. Run without --write to see them.`);
  }
  const rows: LeftRow[] = [];
  const undo: any[] = [];
  const undoFile = opts.write && left.length ? `rejected-deposit-payments-undo-${Date.now()}.json` : undefined;
  if (undoFile) {
    writeFileSync(undoFile, JSON.stringify(left.map((h) => ({ invoiceId: String(h.inv._id), organizationId: String(h.inv.organizationId), payment: h.p })), null, 2));
  }
  for (const h of left) {
    const d = byKey.get(`${h.inv.organizationId}:${h.externalId}`)!;
    const row: LeftRow = {
      depositId: String(d._id), externalId: h.externalId, status: d.status, student: String(d.student?.name ?? ""),
      invoice: String(h.inv.invoiceNumber ?? ""), receipt: String(h.p.receiptNumber ?? ""), amount: money(Number(h.p.amountMinor ?? 0), h.inv.currency ?? "AED"),
      outcome: "would take off",
    };
    if (opts.write) {
      try {
        const removed = await takeOffRecordedPayments(d);
        await TetraDepositModel.updateOne({ _id: d._id }, {
          $push: { events: { at: new Date(), kind: "payment_removed", byName: "", text: `Its payment came off — the request is ${d.status} here (${removed.map((r) => `${money(r.amountMinor, r.currency)} off ${r.invoiceNumber}`).join(", ")})` } },
        });
        row.outcome = "taken off";
        undo.push(h);
      } catch (err) {
        row.outcome = "kept (reconciled)";
        console.warn(`${row.invoice}: ${(err as Error).message}`);
      }
    }
    rows.push(row);
  }
  return { rows, undoFile };
}

/** The payments taken off, recorded again as they were — the same receipt numbers. */
export async function undoRejectedDepositPayments(file: string): Promise<number> {
  const { recordPayment } = await import("../modules/invoice/invoice.service");
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const saved = JSON.parse(readFileSync(file, "utf8")) as { invoiceId: string; organizationId: string; payment: any }[];
  let back = 0;
  for (const s of saved) {
    const p = s.payment;
    await recordPayment(s.organizationId, s.invoiceId, {
      method: p.method, amountMinor: p.amountMinor, paidOn: new Date(p.paidOn).toISOString().slice(0, 10),
      reference: p.reference ?? "", notes: p.notes ?? "", accountName: p.accountName ?? "", chargesMinor: p.chargesMinor ?? 0,
      ...(p.bankAccountId ? { bankAccountId: String(p.bankAccountId) } : {}),
    } as never, undefined, { externalRef: p.externalRef, proofUrl: p.proofUrl || "" });
    if (p.receiptNumber) {
      await Invoice.updateOne({ _id: new Types.ObjectId(s.invoiceId), "payments.externalRef": p.externalRef }, { $set: { "payments.$.receiptNumber": p.receiptNumber } });
    }
    back++;
  }
  return back;
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? String(process.argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  if (arg("--undo")) {
    console.log(`Recorded ${await undoRejectedDepositPayments(arg("--undo"))} payment(s) again from ${arg("--undo")}.`);
  } else {
    const write = process.argv.includes("--write");
    const expect = arg("--expect") ? Number(arg("--expect")) : undefined;
    const { rows, undoFile } = await rejectedDepositPayments({ write, expect });
    for (const r of rows) console.log(`${r.invoice.padEnd(12)} ${r.receipt.padEnd(12)} ${r.student.slice(0, 26).padEnd(26)} ${r.amount.padStart(14)}  request ${r.status.padEnd(8)} …${r.externalId.slice(-6)}  ${r.outcome}`);
    console.log(`\n${rows.length} payment(s) on an invoice for a request finance no longer approves.`);
    if (undoFile) console.log(`Undo file: ${undoFile}`);
    if (!write) console.log(`Nothing written. To do it: bun src/scripts/rejected-deposit-payments.ts --write --expect ${rows.length}`);
  }
  await mongoose.disconnect();
}
