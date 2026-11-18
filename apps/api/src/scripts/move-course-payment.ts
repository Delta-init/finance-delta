/**
 * A CS Portal course payment that made a new invoice when it was the next payment of one the client already has
 * (the user, 2026-11-18: a client enrolled for one course got an "overdue" email for a second invoice the CS's next
 * payment opened — "partial payment instead of new"). Moves the payment, by its receipt number, onto the invoice it
 * pays towards and voids the one it made:
 *
 *   1. recorded on --to as the invoice screen records one (its bank line, CS Portal's fee update), the same method,
 *      amount, day, rupees and rate, receipt and request — and the same receipt number;
 *   2. taken off --from (its bank line with it) and --from voided — refused when --from has any other payment;
 *   3. the CS Portal request says --to, and CS Portal is told (it keeps the invoice from a repeat of the decision) —
 *      so are the other requests already on --to, whose rows there still show what was left before (2026-11-18);
 *   4. --fix-ref RCT-…=<reference>: a payment's reference on --to corrected (the bank's transaction id) — refused when
 *      another payment in the organisation has it.
 *
 * No email to the client. Reads and prints only, unless --write; --write saves both invoices and the request as they
 * were first (move-course-payment-<from>-<time>.json, read back before anything changes). Each step is skipped when
 * it is done, so a run cut short is finished by running it again. Run it from apps/api on the server:
 *
 *   bun src/scripts/move-course-payment.ts --from IN-00002 --to IN-00001 --receipt RCT-00002 [--fix-ref RCT-00001=<ref>] [--org <name|id>] [--write]
 */
import mongoose, { Types } from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";
import { formatMoney } from "@delta/shared";

export interface MoveOpts {
  from: string; to: string; receipt: string;
  /** Whose invoices (name or id), when more than one organization has those numbers. */
  org?: string;
  fixRef?: { receipt: string; reference: string };
  write: boolean;
  /** CS Portal told again; the checks pass their own. */
  tell?: (depositId: string) => Promise<string>;
  /** Where the backup goes (the current directory). */
  dir?: string;
}

const day = (d: unknown) => new Date(d as Date).toISOString().slice(0, 10);

export function parseFixRef(v: string): MoveOpts["fixRef"] {
  if (!v) return undefined;
  const [receipt, reference] = v.split("=").map((s) => s.trim());
  if (!/^RCT-\d+$/i.test(receipt ?? "") || !reference) throw new Error(`--fix-ref "${v}": write it as RCT-00001=<reference>`);
  return { receipt: receipt!.toUpperCase(), reference: reference.slice(0, 200) };
}

export async function moveCoursePayment(opts: MoveOpts): Promise<{ lines: string[]; backupFile?: string }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { Organization } = await import("../modules/organization/organization.model");
  const { TetraDepositModel } = await import("../modules/tetra-deposit/tetra-deposit.model");
  const inv = await import("../modules/invoice/invoice.service");
  const { assertLineMovable, syncPaymentLine } = await import("../modules/invoice/payment-bank");
  const { assertReferenceFree } = await import("../modules/invoice/payment-reference");
  const lines: string[] = [];
  const say = (s: string) => lines.push(s);

  // Whose: the organization both numbers are in.
  let orgFilter: Record<string, unknown> = {};
  if (opts.org) {
    const org = Types.ObjectId.isValid(opts.org)
      ? await Organization.findById(opts.org).lean<any>()
      : await Organization.findOne({ name: new RegExp(`^${opts.org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }).lean<any>();
    if (!org) throw new Error(`No organization ${opts.org}`);
    orgFilter = { organizationId: org._id };
  }
  const one = async (number: string) => {
    const found = await Invoice.find({ invoiceNumber: number, ...orgFilter }).lean<any[]>();
    if (!found.length) throw new Error(`No invoice ${number}`);
    if (found.length > 1) throw new Error(`${number} is in ${found.length} organizations — say which with --org`);
    return found[0]!;
  };
  let from = await one(opts.from);
  let to = await one(opts.to);
  const orgId = String(from.organizationId);
  if (String(to.organizationId) !== orgId) throw new Error(`${opts.from} and ${opts.to} are in different organizations`);
  if (String(to.customerId) !== String(from.customerId)) throw new Error(`${opts.from} (${from.customerName}) and ${opts.to} (${to.customerName}) are not the same client's`);
  if ((to.currency ?? "AED") !== (from.currency ?? "AED")) throw new Error(`${opts.from} is in ${from.currency}, ${opts.to} in ${to.currency}`);
  if (to.status === "void") throw new Error(`${opts.to} is void`);
  const cur = to.currency ?? "AED";

  const onFrom = (from.payments ?? []).find((p: any) => p.receiptNumber === opts.receipt);
  const onTo = (to.payments ?? []).find((p: any) => p.receiptNumber === opts.receipt);
  const moving = onFrom ?? onTo;
  if (!moving) throw new Error(`${opts.receipt} is on neither ${opts.from} nor ${opts.to}`);
  if (!moving.externalRef) throw new Error(`${opts.receipt} is not a payment from CS Portal (it has no request) — this moves only those`);
  const others = (from.payments ?? []).filter((p: any) => p.receiptNumber !== opts.receipt);
  if (others.length) throw new Error(`${opts.from} has other payments (${others.map((p: any) => p.receiptNumber || formatMoney(p.amountMinor, cur)).join(", ")}) — not voided by this`);
  const recordedOnTo = (to.payments ?? []).some((p: any) => p.externalRef === moving.externalRef);
  if (!recordedOnTo && (to.balanceMinor ?? 0) < moving.amountMinor) {
    throw new Error(`${formatMoney(moving.amountMinor, cur)} is more than the ${formatMoney(to.balanceMinor ?? 0, cur)} left on ${opts.to}`);
  }
  const externalId = String(moving.externalRef).replace(/^tetra:/, "");
  const deposit = await TetraDepositModel.findOne({ organizationId: from.organizationId, externalId }).lean<any>();

  const money = (m: number) => formatMoney(m, cur);
  const rupees = moving.original ? ` (${formatMoney(moving.original.amountMinor, moving.original.currency)})` : "";
  say(`${from.customerName}: ${opts.receipt} — ${money(moving.amountMinor)}${rupees} by ${String(moving.method).replace(/_/g, " ")}, paid ${day(moving.paidOn)}`);
  say(`  now:   ${opts.from} fee ${money(from.totalMinor)}, paid ${money(from.amountPaidMinor)}, ${from.status}  ·  ${opts.to} fee ${money(to.totalMinor)}, paid ${money(to.amountPaidMinor)}, balance ${money(to.balanceMinor)}, ${to.status}`);
  const paidAfter = (to.amountPaidMinor ?? 0) + (recordedOnTo ? 0 : moving.amountMinor);
  say(`  after: ${opts.to} paid ${money(paidAfter)}, balance ${money((to.totalMinor ?? 0) - paidAfter)}  ·  ${opts.from} void`);
  say(`  CS Portal request: ${deposit ? `${deposit.type} ${deposit.externalId}, now on ${deposit.courseInvoice?.invoiceNumber ?? "—"} → ${opts.to}` : "not found here — CS Portal is not told"}`);
  // The other requests on --to: CS Portal shows each with what was left when it was decided — told again, the new figure.
  const alsoOnTo = (await TetraDepositModel.find({ "courseInvoice.invoiceId": to._id, status: "approved", ...(deposit ? { _id: { $ne: deposit._id } } : {}) }).select("_id externalId courseInvoice").lean<any[]>());
  if (alsoOnTo.length) say(`  also told again: ${alsoOnTo.map((d) => `${d.externalId} (${d.courseInvoice?.receiptNumber ?? "—"})`).join(", ")}`);
  let fixTarget: any = null;
  if (opts.fixRef) {
    fixTarget = (to.payments ?? []).find((p: any) => p.receiptNumber === opts.fixRef!.receipt);
    if (!fixTarget) throw new Error(`--fix-ref: ${opts.fixRef.receipt} is not on ${opts.to}`);
    if (fixTarget.reference !== opts.fixRef.reference) await assertReferenceFree(orgId, opts.fixRef.reference, String(fixTarget._id));
    say(`  ${opts.fixRef.receipt}'s reference: "${fixTarget.reference ?? ""}" → "${opts.fixRef.reference}"`);
  }
  // Its bank line must be movable (not reconciled) before anything changes.
  if (onFrom) await assertLineMovable(orgId, onFrom);
  if (!opts.write) return { lines };

  // ── Writes ──
  const backupFile = `${opts.dir ?? process.cwd()}/move-course-payment-${opts.from}-${Date.now()}.json`;
  writeFileSync(backupFile, JSON.stringify({ at: new Date().toISOString(), from, to, deposit }, null, 2));
  const back = JSON.parse(readFileSync(backupFile, "utf8"));
  if (back?.from?.invoiceNumber !== opts.from || back?.to?.invoiceNumber !== opts.to) throw new Error(`The backup ${backupFile} did not read back whole — nothing changed`);
  say(`Backup: ${backupFile}`);

  // 1. Onto --to, as it was.
  if (!recordedOnTo) {
    await inv.recordPayment(orgId, String(to._id), {
      method: moving.method, amountMinor: moving.amountMinor, paidOn: day(moving.paidOn), reference: moving.reference ?? "",
      notes: `${moving.notes ? `${moving.notes} · ` : ""}moved from ${opts.from} (2026-11-18)`.slice(0, 1000),
      accountName: "", chargesMinor: moving.chargesMinor ?? 0,
      ...(moving.bankAccountId ? { bankAccountId: String(moving.bankAccountId) } : {}),
    } as never, undefined, { externalRef: moving.externalRef, proofUrl: moving.proofUrl ?? "", ...(moving.original ? { original: moving.original } : {}) });
    say(`Recorded on ${opts.to}`);
  } else say(`Already on ${opts.to}`);
  await Invoice.updateOne(
    { _id: to._id, payments: { $elemMatch: { externalRef: moving.externalRef, receiptNumber: { $exists: false } } } },
    { $set: { "payments.$.receiptNumber": opts.receipt } },
  );
  const toDoc = await Invoice.findById(to._id);
  const added = (toDoc?.payments as any[] | undefined)?.find((p: any) => p.externalRef === moving.externalRef);
  if (!toDoc || !added) throw new Error(`The payment is not on ${opts.to} — stopped`);
  // Its bank line named by the receipt number, as the first one was.
  await syncPaymentLine(toDoc as never, added._id);

  // 2. Off --from, and --from voided.
  from = await Invoice.findById(from._id).lean<any>();
  const still = (from.payments ?? []).find((p: any) => p.externalRef === moving.externalRef);
  if (still) { await inv.deletePayment(orgId, String(from._id), String(still._id)); say(`Taken off ${opts.from}`); }
  from = await Invoice.findById(from._id).lean<any>();
  if (from.status !== "void") { await inv.voidInvoice(orgId, String(from._id)); say(`${opts.from} voided`); } else say(`${opts.from} already void`);

  // 3. The request says --to, and CS Portal hears it.
  if (deposit) {
    await TetraDepositModel.updateOne({ _id: deposit._id }, {
      $set: {
        "courseInvoice.invoiceId": to._id, "courseInvoice.invoiceNumber": opts.to, "courseInvoice.paymentId": added._id,
        "courseInvoice.receiptNumber": opts.receipt, "courseInvoice.created": false, "courseInvoice.at": new Date(),
      },
      $push: { events: { at: new Date(), kind: "moved", byName: "", text: `Payment ${opts.receipt} moved from ${opts.from} to ${opts.to}; ${opts.from} voided` } },
    });
  }
  const tell = opts.tell ?? (await import("../modules/tetra-deposit/tetra-deposit.service")).tellCommissionCourseInvoice;
  for (const d of [...(deposit ? [deposit] : []), ...alsoOnTo]) {
    try { say(await tell(String(d._id))); }
    catch (e) { say(`CS Portal not told about ${d.externalId}: ${(e as Error).message} — run this again to tell it`); }
  }

  // 4. The reference.
  if (opts.fixRef && fixTarget && fixTarget.reference !== opts.fixRef.reference) {
    await Invoice.updateOne({ _id: to._id, "payments._id": fixTarget._id }, { $set: { "payments.$.reference": opts.fixRef.reference } });
    say(`${opts.fixRef.receipt}'s reference is ${opts.fixRef.reference}`);
  }

  to = await Invoice.findById(to._id).lean<any>();
  say(`Now: ${opts.to} paid ${money(to.amountPaidMinor)}, balance ${money(to.balanceMinor)}, ${to.status}, next due ${to.dueDate ? day(to.dueDate) : "—"}`);
  return { lines, backupFile };
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    const write = argv.includes("--write");
    const r = await moveCoursePayment({
      from: arg("--from").toUpperCase(), to: arg("--to").toUpperCase(), receipt: arg("--receipt").toUpperCase(),
      org: arg("--org") || undefined, fixRef: parseFixRef(arg("--fix-ref")), write,
    });
    for (const l of r.lines) console.log(l);
    if (!write) console.log("\nNothing written. Check it, then run the same command with --write.");
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  // The fee updates are queued in the background: a moment for them before the connection closes.
  await new Promise((r) => setTimeout(r, 3000));
  await mongoose.disconnect();
}
