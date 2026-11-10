/**
 * Nothing in finance deletes a stored file (the user, 2026-11-10: a close receipt taken off an invoice was deleted
 * from storage, and the sales CRM's lead and the CS Portal — which link the same file — showed it gone. "No auto
 * removal needed in the storage").
 *
 * What it proves, through the real services against a throwaway database, with the storage client recording every
 * command it is sent:
 *   - a document taken off an invoice — a sales CRM's close receipt, a balance-payment receipt, finance's own upload —
 *     leaves the invoice, and nothing is deleted from storage;
 *   - the same for a bill's document, an expense's receipt (taken off, and the expense deleted) and a bank line's receipt;
 *   - no code in the API (scripts aside) builds a storage delete command at all, so none can come back unnoticed.
 *
 * Run through scripts/stored-files-kept-e2e.sh (throwaway mongod, no .env anywhere).
 */
import { mock } from "bun:test";
import mongoose, { Types } from "mongoose";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

/* The storage client, recording what it is asked to do — no R2 anywhere. */
const sent: string[] = [];
class Command { constructor(public input: unknown) {} }
mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class { async send(cmd: object) { sent.push(cmd.constructor.name); return {}; } },
  PutObjectCommand: class PutObjectCommand extends Command {},
  GetObjectCommand: class GetObjectCommand extends Command {},
  HeadObjectCommand: class HeadObjectCommand extends Command {},
  DeleteObjectCommand: class DeleteObjectCommand extends Command {},
  DeleteObjectsCommand: class DeleteObjectsCommand extends Command {},
}));

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => String(JSON.stringify(v)).slice(0, 400);
const deletes = () => sent.filter((c) => /Delete/.test(c));

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const ORG = new Types.ObjectId(), CUST = new Types.ObjectId();
const ALL = { all: true } as const;
await db.collection("organizations").insertOne({ _id: ORG, name: "Delta HQ", baseCurrency: "AED" });
await db.collection("customers").insertOne({ _id: CUST, organizationId: ORG, customerCode: "CUST-00001", name: "Student", email: "s@e2e.local" });

const file = (key: string) => ({ name: key.split("/").pop()!, url: `https://files.e2e.test/${key}`, key, size: 10, mimeType: "image/jpeg", uploadedAt: new Date("2026-10-29") });

const invoice = await import("../modules/invoice/invoice.service");
const bill = await import("../modules/bill/bill.service");
const expense = await import("../modules/expense/expense.service");
const banking = await import("../modules/banking/banking.service");
const { uploadFile } = await import("../lib/storage");

step("The storage client is live in this test");
await uploadFile({ key: "probe/one.txt", buffer: Buffer.from("x"), mimeType: "text/plain", originalName: "one.txt" });
check("an upload reaches it (so a delete would be seen)", sent.includes("PutObjectCommand"), show(sent));
sent.length = 0;

step("An invoice's documents");
const vat = (g: number) => Math.round((g * 5) / 105);
const total = 225_000;
const INV = new Types.ObjectId();
const close = file(`enrolment-receipts/${new Types.ObjectId()}/1793292590525-WhatsApp_Image.jpeg`);
const balance = file(`balance-receipts/${new Types.ObjectId()}/1793300000000-slip.jpeg`);
const own = file(`invoices/${ORG}/${INV}/1793310000000-image.png`);
await db.collection("invoices").insertOne({
  _id: INV, organizationId: ORG, invoiceNumber: "IN-00254", customerId: CUST, customerName: "Student", salespersonId: new Types.ObjectId(), salespersonName: "Rep",
  issueDate: new Date("2026-10-29"), dueDate: new Date("2026-10-29"), currency: "AED", exchangeRate: 1, taxInclusive: true, status: "paid",
  lineItems: [{ description: "Course", quantity: 1, unitPriceMinor: total, discountPct: 0, taxes: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], lineSubtotalMinor: total - vat(total), discountMinor: 0, taxableMinor: total - vat(total), taxTotalMinor: vat(total), lineTotalMinor: total }],
  subtotalMinor: total - vat(total), discountTotalMinor: 0, taxBreakdown: [{ code: "VAT", rate: 5, amountMinor: vat(total) }], taxTotalMinor: vat(total), roundOffMinor: 0,
  totalMinor: total, baseTotalMinor: total, amountPaidMinor: total, balanceMinor: 0, approval: { state: "approved" }, payments: [],
  attachments: [close, balance, own], createdAt: new Date("2026-10-29"), updatedAt: new Date("2026-10-29"),
});
const keysOn = async (c: string, id: Types.ObjectId) => (((await db.collection(c).findOne({ _id: id })) as any)?.attachments ?? []).map((a: any) => a.key);
for (const [label, f] of [["the sales CRM's close receipt", close], ["a balance-payment receipt", balance], ["finance's own upload", own]] as const) {
  let error = "";
  try { await invoice.removeAttachment(String(ORG), String(INV), f.key, ALL); } catch (e) { error = String((e as Error).message); }
  check(`${label}: off the invoice`, !error && !(await keysOn("invoices", INV)).includes(f.key), error);
  check("…and not deleted from storage", deletes().length === 0, show(sent));
}

step("A bill's document");
const BILL = new Types.ObjectId(), BATT = new Types.ObjectId();
await db.collection("bills").insertOne({
  _id: BILL, organizationId: ORG, billNumber: "BILL-00001", vendorId: new Types.ObjectId(), vendorName: "Vendor", billDate: new Date("2026-10-29"), dueDate: new Date("2026-11-29"),
  currency: "AED", status: "draft", lineItems: [], payments: [], attachments: [{ _id: BATT, ...file(`bills/${ORG}/${BILL}/1-bill.pdf`) }], createdAt: new Date(), updatedAt: new Date(),
});
{
  let error = "";
  try { await bill.removeBillAttachment(String(ORG), String(BILL), String(BATT)); } catch (e) { error = String((e as Error).message); }
  check("off the bill", !error && (await keysOn("bills", BILL)).length === 0, error);
  check("…and not deleted from storage", deletes().length === 0, show(sent));
}

step("An expense's receipts");
const EXP = new Types.ObjectId();
const r1 = file(`expenses/${ORG}/1-receipt.jpeg`), r2 = file(`expenses/${ORG}/2-receipt.jpeg`);
await db.collection("expenses").insertOne({
  _id: EXP, organizationId: ORG, expenseNumber: "EXP-00001", category: "office", categoryName: "Office", description: "Paper", expenseDate: new Date("2026-10-29"),
  amountMinor: 10_000, totalMinor: 10_000, currency: "AED", status: "draft", submittedById: new Types.ObjectId(), submittedByName: "Claimant", attachments: [r1, r2], createdAt: new Date(), updatedAt: new Date(),
});
{
  let error = "";
  try { await expense.removeAttachment(String(ORG), String(EXP), r1.key, ALL); } catch (e) { error = String((e as Error).message); }
  check("one taken off", !error && !(await keysOn("expenses", EXP)).includes(r1.key), error);
  check("…and not deleted from storage", deletes().length === 0, show(sent));
  error = "";
  try { await expense.deleteExpense(String(ORG), String(EXP)); } catch (e) { error = String((e as Error).message); }
  check("the expense deleted", !error && !(await db.collection("expenses").findOne({ _id: EXP })), error);
  check("…its other receipt not deleted from storage", deletes().length === 0, show(sent));
}

step("A bank line's receipt");
const ACC = new Types.ObjectId(), TX = new Types.ObjectId();
const slip = file(`bank/${ORG}/1-slip.jpeg`);
await db.collection("bankaccounts").insertOne({ _id: ACC, organizationId: ORG, accountName: "Delta Bank", accountType: "current", currency: "AED", currentBalanceMinor: 0, openingBalanceMinor: 0, openingDate: new Date("2026-01-01"), createdAt: new Date(), updatedAt: new Date() });
await db.collection("banktransactions").insertOne({ _id: TX, organizationId: ORG, accountId: ACC, accountName: "Delta Bank", currency: "AED", date: new Date("2026-10-29"), description: "Deposit", type: "credit", amountMinor: 5_000, runningBalanceMinor: 5_000, attachments: [slip], createdAt: new Date(), updatedAt: new Date() });
{
  let error = "";
  try { await banking.removeTransactionAttachment(String(ORG), String(ACC), String(TX), slip.key); } catch (e) { error = String((e as Error).message); }
  check("off the line", !error && (await keysOn("banktransactions", TX)).length === 0, error);
  check("…and not deleted from storage", deletes().length === 0, show(sent));
}

step("No code builds a storage delete");
const found: string[] = [];
async function scan(dir: string) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "scripts" && e.name !== "node_modules") await scan(p); continue; }
    if (!/\.ts$/.test(e.name)) continue;
    if (/DeleteObjects?Command/.test(await readFile(p, "utf8"))) found.push(p.slice(p.indexOf("src/")));
  }
}
await scan(join(import.meta.dir, ".."));
check("none in apps/api/src (scripts aside)", found.length === 0, found.join(", "));

await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
