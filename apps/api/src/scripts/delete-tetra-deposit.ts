/**
 * A CS Portal deposit deleted by hand, as Tetra Deposits → Delete does it (the user, 2026-10-28: "delete fawas
 * that approved deposit and the invoice also") — with finance's own deleteTetraDeposit, so the same refusals hold: not
 * one waiting for a decision, not one still on its way to CS Portal, not an approval whose payment is still on
 * an invoice. It is kept as "deleted" (who, when, why, what it was) and Restore on the page puts it back. CS
 * Portal is not told. The invoice it went on is deleted separately, with delete-invoices.ts.
 *
 * Reads and prints only, unless --write. From apps/api (Bun reads MONGODB_URI from the .env):
 *
 *   bun src/scripts/delete-tetra-deposit.ts <deposit id> --reason "<why>" --by <email of who it is done for>
 *   bun src/scripts/delete-tetra-deposit.ts <deposit id> --reason "<why>" --by <email> --write
 */
import mongoose from "mongoose";
import { formatMoney } from "@delta/shared";
import { TetraDepositModel } from "../modules/tetra-deposit/tetra-deposit.model";
import { deleteTetraDeposit } from "../modules/tetra-deposit/tetra-deposit.service";
import { User } from "../modules/user/user.model";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? "" : ""; };
const write = args.includes("--write");
const id = args.find((a) => /^[a-f0-9]{24}$/.test(a)) ?? "";
const reason = flag("--reason").trim();
const by = flag("--by").trim().toLowerCase();
if (!id || reason.length < 3 || !by) {
  console.error('Usage: bun src/scripts/delete-tetra-deposit.ts <deposit id> --reason "<why>" --by <email> [--write]');
  process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI!);
const row = await TetraDepositModel.findById(id).lean<any>();
if (!row) { console.error(`No Tetra deposit ${id}`); process.exit(1); }
const user = await User.findOne({ email: by }).select("name email memberships").lean<any>();
if (!user) { console.error(`No finance user ${by}`); process.exit(1); }

const amount = formatMoney(row.decision?.approvedAmountMinor ?? row.amountMinor, row.currency ?? "USD");
console.log(`${row.student?.name} (${row.student?.code}) · ${row.type} · ${amount} · ${row.status} · raised ${row.requestedAt?.toISOString?.() ?? ""} by ${row.requestedBy}`);
if (row.decision?.decidedAt) console.log(`  decided ${row.decision.decidedAt.toISOString()} by ${row.decision.decidedByName}, transaction ${row.decision.transactionId ?? "—"}; CS Portal: ${row.delivery?.state ?? "—"}`);
if (row.coursePayment) console.log(`  course ${row.coursePayment.product} (${row.coursePayment.kind}), MT5 bonus USD ${row.coursePayment.bonusUsd}`);
if (row.courseInvoice?.invoiceNumber) console.log(`  its payment: ${row.courseInvoice.receiptNumber} on invoice ${row.courseInvoice.invoiceNumber}`);
console.log(`  to be deleted for ${user.name} <${user.email}>: "${reason}"`);

if (!write) {
  console.log("\nDry run — nothing changed. Add --write to delete it.");
  await mongoose.disconnect();
  process.exit(0);
}
try {
  const done = await deleteTetraDeposit(
    { userId: String(user._id), organizationId: String(row.organizationId), role: "", permissions: [], isSuperAdmin: false },
    id, { reason },
  );
  console.log(`\nDeleted — now "${done.status}" (it was ${done.deleted?.previousStatus}). Restore puts it back: Tetra Deposits → Deleted.`);
} catch (err) {
  console.error(`\nNot deleted: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
await mongoose.disconnect();
