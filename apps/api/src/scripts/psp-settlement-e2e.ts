/**
 * PSP accounts and their settlements (the user, 2026-11-06: "PSP banks … settlement with charges, which bank it moves
 * to, and set up how much the charges are"), against a scratch database.
 *
 * What it proves:
 *   - a PSP account's settings: it settles into another open account of its currency, never a PSP; an existing
 *     account switched to PSP counts what came before its start day as settled already;
 *   - a payment into a PSP account lands whole — no charges line of its own, even with charges typed;
 *   - what waits to be settled, each with its expected day — and no guessed fee: the account keeps no rate (the user,
 *     2026-11-14: "each settlement has its own charges… remove that from the settings"); one set up with a rate
 *     before still works, and nothing reads the rate it holds;
 *   - a settlement: the bank gets what arrived, the PSP account gives up all it settled (the transfer and the charges),
 *     its own charges are an expense in Bank Fees & Charges › Payment Gateway Fees with their VAT split out, the
 *     payments marked; another settlement of the same account has other charges, or none;
 *   - charges typed that are not what was settled less what arrived: refused;
 *   - refused: more arriving than was settled, a payment settled twice, changing a settled payment, deleting the fee
 *     expense or the transfer on their own;
 *   - deleting the settlement puts everything back as it was; not once its transfer is reconciled.
 *
 * Run through scripts/psp-settlement-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { Expense } = await import("../modules/expense/expense.model");
const banking = await import("../modules/banking/banking.service");
const { deleteTransfer } = await import("../modules/banking/transfer.service");
const { recordPayment, updatePayment } = await import("../modules/invoice/invoice.service");
const { deleteExpense } = await import("../modules/expense/expense.service");
const psp = await import("../modules/psp-settlement/psp-settlement.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 600);
const errOf = async (f: () => Promise<unknown>) => { try { await f(); return ""; } catch (e) { return (e as Error).message; } };

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const ORG = new Types.ObjectId(), org = String(ORG);
const USER = { userId: String(new Types.ObjectId()), name: "Accountant" };
await mongoose.connection.db!.collection("organizations").insertOne({ _id: ORG, name: "Delta HQ", baseCurrency: "AED" });
const acct = (o: Record<string, unknown>) => banking.createBankAccount(org, {
  accountName: "x", accountNumber: "", bankName: "", branch: "", ifsc: "", swift: "", iban: "", accountType: "current", currency: "AED",
  openingBalanceMinor: 0, openingDate: "2026-10-01", notes: "", ...o,
} as never);
const adcb = await acct({ accountName: "ADCB", openingBalanceMinor: 1_000_000 });
const inr = await acct({ accountName: "Federal INR", currency: "INR" });
const settings = { provider: "Tabby", feeVatPct: 5, settlementAccountId: adcb.id, settlementDays: 7 };
const balance = async (id: string) => (await BankAccount.findById(id).lean<any>())!.currentBalanceMinor;

step("1. A PSP account's settings");
check("settling into an account of another currency: refused", /in INR/.test(await errOf(() => acct({ accountName: "Bad", accountType: "psp", psp: { ...settings, settlementAccountId: inr.id } }))));
const tabby = await acct({ accountName: "Tabby", accountType: "psp", psp: { ...settings, startDate: "2026-11-01" } });
check("made: its settings kept, the bank named — and no rate for its charges among them", tabby.accountType === "psp" && tabby.psp?.feeVatPct === 5 && tabby.psp?.settlementAccountName === "ADCB" && tabby.psp?.startDate === "2026-11-01"
  && !("feePct" in (tabby.psp ?? {})) && !("fixedFeeMinor" in (tabby.psp ?? {})), j(tabby.psp));
// A rate sent by a screen from before (the settings used to take one) is simply not kept.
const withRate = await acct({ accountName: "Old screen", accountType: "psp", psp: { ...settings, feePct: 5.5, fixedFeeMinor: 100 } });
const storedRate = await BankAccount.collection.findOne({ _id: new Types.ObjectId(withRate.id) });
check("a rate sent by an older screen is not kept", !("feePct" in (withRate.psp ?? {})) && storedRate?.psp?.feePct === undefined && storedRate?.psp?.fixedFeeMinor === undefined, j(storedRate?.psp));
await BankAccount.collection.deleteOne({ _id: new Types.ObjectId(withRate.id) });
check("settling into another PSP: refused", /not another PSP/.test(await errOf(() => acct({ accountName: "Bad2", accountType: "psp", psp: { ...settings, settlementAccountId: tabby.id } }))));
// An existing account, with money already in it, switched to PSP: what came before its start is settled already.
const tamara = await acct({ accountName: "Tamara" });
await banking.addTransaction(org, tamara.id, { date: "2026-10-20", description: "Old money in", reference: "", amountMinor: 50_000, notes: "" } as never);
const switched = await banking.updateBankAccount(org, tamara.id, { accountType: "psp", psp: { ...settings, provider: "Tamara", startDate: "2026-11-01" } } as never);
check("an existing account switched to PSP", switched.accountType === "psp" && switched.psp?.provider === "Tamara");
check("…its money from before the start day is not waiting to be settled", (await psp.unsettledLines(org, tamara.id)).length === 0);
// An account set up while the settings still took a rate holds one in the database: it reads as any other, without it.
await BankAccount.collection.updateOne({ _id: new Types.ObjectId(tamara.id) }, { $set: { "psp.feePct": 5.5, "psp.fixedFeeMinor": 100 } });
const old = await banking.getBankAccount(org, tamara.id);
check("an account that held a rate from before: read without it, still a PSP with its VAT rate", old.accountType === "psp" && old.psp?.feeVatPct === 5 && !("feePct" in (old.psp ?? {}))
  && (await psp.pspSummary(org, tamara.id)).unsettledCount === 0, j(old.psp));

step("2. Payments land whole");
const inv = { _id: new Types.ObjectId() };
await mongoose.connection.db!.collection("invoices").insertOne({ _id: inv._id, organizationId: ORG, invoiceNumber: "IN-00001", customerId: new Types.ObjectId(), customerName: "Student",
  salespersonId: new Types.ObjectId(), salespersonName: "Rep", issueDate: new Date("2026-11-02"), dueDate: new Date("2026-11-02"), currency: "AED", status: "sent",
  lineItems: [{ description: "Course", quantity: 1, unitPriceMinor: 500_000, discountPct: 0, taxes: [], lineSubtotalMinor: 500_000, discountMinor: 0, taxableMinor: 500_000, taxTotalMinor: 0, lineTotalMinor: 500_000 }],
  subtotalMinor: 500_000, discountTotalMinor: 0, taxBreakdown: [], taxTotalMinor: 0, totalMinor: 500_000, amountPaidMinor: 0, balanceMinor: 500_000,
  approval: { state: "not_required" }, payments: [], createdAt: new Date("2026-11-02"), updatedAt: new Date("2026-11-02") });
const pay = (amountMinor: number, paidOn: string, chargesMinor = 0) => recordPayment(org, String(inv._id), { method: "tabby", amountMinor, paidOn, reference: "", notes: "", accountName: "", chargesMinor, bankAccountId: tabby.id } as never);
let d = await pay(200_000, "2026-11-02", 9_000);
const p1 = d.payments[0]!;
const p1Lines = await BankTransaction.find({ accountId: tabby.id }).lean<any[]>();
check("AED 2,000 with charges typed: one line in Tabby, the whole 2,000, no charges line", p1Lines.length === 1 && p1Lines[0].amountMinor === 200_000 && p1Lines[0].type === "credit", j(p1Lines.map((l) => [l.type, l.amountMinor])));
d = await pay(100_000, "2026-11-03");
await banking.addTransaction(org, tabby.id, { date: "2026-11-04", description: "Paid at the counter", reference: "", amountMinor: 30_000, notes: "" } as never);
const before = { tabby: await balance(tabby.id), adcb: await balance(adcb.id) };
check("Tabby holds 3,300, ADCB 10,000", before.tabby === 330_000 && before.adcb === 1_000_000, j(before));

step("3. Waiting to be settled");
let waiting = await psp.unsettledLines(org, tabby.id);
check("three, oldest first, each with its expected day — and no guessed fee", waiting.length === 3 && waiting[0]!.amountMinor === 200_000 && !("expectedFeeMinor" in waiting[0]!)
  && waiting[0]!.expectedOn === "2026-11-09" && waiting[0]!.invoice?.number === "IN-00001" && waiting[2]!.invoice === null, j(waiting));
const sum = await psp.pspSummary(org, tabby.id);
check("the summary: 3,300 in 3, no fee guessed", sum.unsettledMinor === 330_000 && sum.unsettledCount === 3 && !("expectedFeeMinor" in sum), j(sum));
const every = await psp.allPspSummaries(org);
const mine = every.find((a) => a.accountId === tabby.id);
check("the dashboard's list: both PSP accounts and no bank, the one holding most first, same figures as its own summary", every.length === 2 && every[0] === mine && !!mine && mine.unsettledMinor === sum.unsettledMinor && !("expectedFeeMinor" in mine) && mine.settlementAccountName === "ADCB" && !!mine.oldestDate && every[1]!.unsettledCount === 0 && every[1]!.oldestDate === null, j(every));
const upTo = await psp.unsettledLines(org, tabby.id, { to: "2026-11-02" });
check("…up to a day: only those", upTo.length === 1);

step("4. A settlement");
const pick = waiting.slice(0, 2).map((l) => l.id);
check("more arriving than was settled: refused", /More arrived/.test(await errOf(() => psp.createSettlement(org, tabby.id, { lineIds: pick, date: "2026-11-10", receivedMinor: 300_001, reference: "", notes: "" }, USER))));
check("charges typed that aren't what was settled less what arrived: refused, nothing booked", /charges typed/.test(await errOf(() => psp.createSettlement(org, tabby.id, { lineIds: pick, date: "2026-11-10", receivedMinor: 282_000, feeMinor: 17_000, reference: "", notes: "" }, USER)))
  && (await psp.listSettlements(org, tabby.id)).length === 0 && (await balance(tabby.id)) === before.tabby && (await psp.unsettledLines(org, tabby.id)).length === 3);
const s = await psp.createSettlement(org, tabby.id, { lineIds: pick, date: "2026-11-10", receivedMinor: 282_000, feeMinor: 18_000, reference: "UTR-9", notes: "" }, USER);
check("PS-00001: 3,000 settled, 2,820 arrived, its own charges 180", s.number === "PS-00001" && s.grossMinor === 300_000 && s.receivedMinor === 282_000 && s.feeMinor === 18_000 && s.lineCount === 2 && s.bankAccountName === "ADCB", j(s));
check("ADCB +2,820; Tabby −3,000 (the 2,820 out, the 180 fee) — 300 left", (await balance(adcb.id)) === 1_282_000 && (await balance(tabby.id)) === 30_000, j({ adcb: await balance(adcb.id), tabby: await balance(tabby.id) }));
const fee = await Expense.findById(s.expense!.id).lean<any>();
check("the fee an expense: Bank Fees & Charges › Payment Gateway Fees, 180 with its 5% VAT split out, paid from Tabby, approved",
  fee?.category === "bank_fees" && fee.subcategory === "payment_gateway_fees" && fee.totalMinor === 18_000 && fee.taxMinor === 18_000 - Math.round(18_000 / 1.05)
  && String(fee.bankAccountId) === tabby.id && fee.status === "approved" && fee.source?.kind === "psp_settlement" && !!fee.bankTransactionId, j(fee));
waiting = await psp.unsettledLines(org, tabby.id);
check("only the counter money still waits", waiting.length === 1 && waiting[0]!.amountMinor === 30_000);
const listed = (await psp.listSettlements(org, tabby.id))[0];
check("listed with its own charges — no expected fee beside them", listed?.feeMinor === 18_000 && !!listed && !("expectedFeeMinor" in listed));
const { pspChargesVatMinor } = await import("@delta/shared");
check("the VAT inside charges: 180 at 5% holds 8.57; none in no charges, none at no rate", pspChargesVatMinor(18_000, 5) === 857 && pspChargesVatMinor(0, 5) === 0 && pspChargesVatMinor(1_000, 0) === 0 && fee.taxMinor === 857);

step("5. Refused while settled");
check("settling a payment twice", /not Tabby's money waiting/.test(await errOf(() => psp.createSettlement(org, tabby.id, { lineIds: [pick[0]!], date: "2026-11-11", receivedMinor: 1_000, reference: "", notes: "" }, USER))));
check("changing a settled payment", /PSP settlement PS-00001/.test(await errOf(() => updatePayment(org, String(inv._id), p1.id, { method: "tabby", amountMinor: 150_000, paidOn: "2026-11-02", reference: "", notes: "", accountName: "", chargesMinor: 0 } as never))));
check("deleting the fee expense on its own", /fee of a PSP settlement/.test(await errOf(() => deleteExpense(org, s.expense!.id))));
const transferLine = await BankTransaction.findOne({ accountId: adcb.id, "settlement.id": new Types.ObjectId(s.id) }).lean<any>();
check("deleting its transfer on its own", /PS-00001/.test(await errOf(() => deleteTransfer(org, String(transferLine.transfer.id)))));

step("6. Taken back");
await BankTransaction.updateOne({ _id: transferLine._id }, { $set: { isReconciled: true } });
check("not once its transfer is reconciled", /reconciled/.test(await errOf(() => psp.deleteSettlement(org, tabby.id, s.id))));
await BankTransaction.updateOne({ _id: transferLine._id }, { $set: { isReconciled: false } });
await psp.deleteSettlement(org, tabby.id, s.id);
check("all back: the balances, the payments waiting, the fee and transfer gone", (await balance(tabby.id)) === before.tabby && (await balance(adcb.id)) === before.adcb
  && (await psp.unsettledLines(org, tabby.id)).length === 3 && !(await Expense.exists({ _id: s.expense!.id }))
  && (await BankTransaction.countDocuments({ "settlement.id": new Types.ObjectId(s.id) })) === 0 && (await psp.listSettlements(org, tabby.id)).length === 0);
const again = await psp.createSettlement(org, tabby.id, { lineIds: pick, date: "2026-11-10", receivedMinor: 300_000, reference: "", notes: "" }, USER);
check("settled again with no fee: PS-00002, no expense", again.number === "PS-00002" && again.feeMinor === 0 && again.expense === null && (await balance(tabby.id)) === 30_000, j(again));

step("7. Each settlement has its own charges");
// The same account, another settlement, other charges: nothing carried over from the one before, nothing from a rate.
const counter = (await psp.unsettledLines(org, tabby.id)).map((l) => l.id);
const third = await psp.createSettlement(org, tabby.id, { lineIds: counter, date: "2026-11-12", receivedMinor: 28_766, feeMinor: 1_234, reference: "UTR-12", notes: "" }, USER);
const thirdFee = await Expense.findById(third.expense!.id).lean<any>();
check("PS-00003: 300 settled, charges 12.34 as typed — where PS-00002 had none", third.number === "PS-00003" && third.grossMinor === 30_000 && third.feeMinor === 1_234 && third.receivedMinor === 28_766
  && thirdFee?.totalMinor === 1_234 && thirdFee.taxMinor === 1_234 - Math.round(1_234 / 1.05) && (await balance(tabby.id)) === 0, j(third));
check("the three settlements, each with what it was charged", (await psp.listSettlements(org, tabby.id)).map((x) => `${x.number}:${x.feeMinor}`).sort().join() === "PS-00002:0,PS-00003:1234", j(await psp.listSettlements(org, tabby.id)));
// An older screen sends no charges, only what arrived: taken as before — the charges are the rest.
await psp.deleteSettlement(org, tabby.id, third.id);
const olderScreen = await psp.createSettlement(org, tabby.id, { lineIds: counter, date: "2026-11-12", receivedMinor: 29_000, reference: "", notes: "" }, USER);
check("what arrived alone (an older screen): the charges are the rest", olderScreen.feeMinor === 1_000 && olderScreen.receivedMinor === 29_000, j(olderScreen));

await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
