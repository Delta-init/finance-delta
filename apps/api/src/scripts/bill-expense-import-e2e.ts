/**
 * Bills and expenses from a spreadsheet (the user, 2026-11-11: "Import option required in Bills" / "…in Expenses"),
 * against a scratch database through finance's own services and routes.
 *
 * What it proves:
 *   1. The shared readers: dd/mm/yyyy by default, mm/dd/yyyy when asked, yyyy-mm-dd and 15-Jan-2026 either way; tax %
 *      and payment methods in words; columns guessed from headings.
 *   2. Expense preview writes nothing and says, per row: ok; unknown category / subcategory / account; a subcategory
 *      missing; an account closed or in another currency; a bad date, amount or method; a repeat of an earlier row; a
 *      repeat of an expense already on file.
 *   3. Expense import: each good row made through createExpense — tax backed out of the amount, approved; paid on its
 *      date with its bank line only when Paid from is given (cash for petty cash); the batch kept; repeats skipped; an
 *      old date opens no late entry (typing the same date by hand would ask for a reason). Importing again: all skipped.
 *   4. Bill preview: matches vendors by name in any case, lists a new vendor, due date from the vendor's terms, repeats
 *      (by bill number, or date and total), paid on without paid from, due before the bill date; someone who can't add
 *      vendors is told so.
 *   5. Bill import: bills made through createBill with their own expense, the vendor's bill number kept, the new vendor
 *      added once, paid in full with a bank line when Paid on + Paid from are given; no late entries; again: skipped.
 *   6. The routes: refused without bill:create / expense:create, a body over 1,000 rows refused, a new vendor needs
 *      vendor:create, and an import over HTTP makes the rows.
 *
 * Run through scripts/bill-expense-import-e2e.sh (throwaway mongod, no .env anywhere).
 */
import http from "node:http";
import mongoose, { Types } from "mongoose";
import express from "express";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const shared = await import("@delta/shared");
const { parseImportDate, parseImportPct, parseImportMethod, guessImportColumns, EXPENSE_IMPORT_FIELDS, BILL_IMPORT_FIELDS, expenseImportSchema, billImportSchema } = shared;
const { Expense } = await import("../modules/expense/expense.model");
const { Bill } = await import("../modules/bill/bill.model");
const { Vendor } = await import("../modules/vendor/vendor.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { ExpenseCategory } = await import("../modules/expense-category/expense-category.model");
const { LateEntryModel } = await import("../modules/late-entry/late-entry.model");
const { ensureDefaults } = await import("../modules/expense-category/expense-category.service");
const { createBankAccount } = await import("../modules/banking/banking.service");
const { createVendor } = await import("../modules/vendor/vendor.service");
const ex = await import("../modules/expense/expense.service");
const bills = await import("../modules/bill/bill.service");
const expImport = await import("../modules/bulk-import/expense-import.service");
const billImport = await import("../modules/bulk-import/bill-import.service");
const { signAccessToken } = await import("../lib/jwt");
const { default: billRoutes } = await import("../modules/bill/bill.routes");
const { default: expenseRoutes } = await import("../modules/expense/expense.routes");
const { errorHandler, notFound } = await import("../middleware/errorHandler");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 500);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

const ORG = new Types.ObjectId(), org = String(ORG);
const me = new Types.ObjectId(), ME = String(me);
// Late entries on at the default (1 day): every date below is long past, so typing any of them would ask a manager.
await db.collection("organizations").insertOne({ _id: ORG, name: "Delta HQ E2E", baseCurrency: "AED" });
await db.collection("users").insertOne({ _id: me, name: "Ivy Importer", email: "ivy@e2e-import.test", status: "active", memberships: [{ organizationId: ORG, status: "active" }] });
await ensureDefaults(org);
// A category from before subcategories: none to give.
await ExpenseCategory.create({ organizationId: ORG, name: "Sundry", slug: "sundry", isSystem: false, inPnl: true, subcategories: [] });
const acct = (accountName: string, currency: string, accountType = "current") =>
  createBankAccount(org, { accountName, currency, accountType, openingBalanceMinor: 10_000_000, openingDate: "2025-01-01" } as never);
const main = await acct("Main Bank", "AED");
const petty = await acct("Petty Cash", "AED", "petty_cash");
const usd = await acct("USD Account", "USD");
const old = await acct("Old Bank", "AED");
await BankAccount.updateOne({ _id: old.id }, { $set: { isActive: false } });
const linesOf = (refId: string) => BankTransaction.find({ "matches.referenceId": refId }).lean<any[]>();
const lateCount = () => LateEntryModel.countDocuments({});

/* ── 1 ── */
step("1. Reading cells");
check("15/01/2026 is 15 January by default", (parseImportDate("15/01/2026") as any).iso === "2026-01-15");
check("03/04/2026: 3 April as dd/mm, 4 March as mm/dd", (parseImportDate("03/04/2026", "dmy") as any).iso === "2026-04-03" && (parseImportDate("03/04/2026", "mdy") as any).iso === "2026-03-04");
check("2026-01-15 and 15-Jan-2026 read the same either way", ["dmy", "mdy"].every((f) => (parseImportDate("2026-01-15", f as never) as any).iso === "2026-01-15" && (parseImportDate("15-Jan-2026", f as never) as any).iso === "2026-01-15"));
check("a time after the date is ignored", (parseImportDate("2026-01-15 00:00:00") as any).iso === "2026-01-15");
check("31/02/2026 is not a date", !parseImportDate("31/02/2026").ok);
check("tax: 5, 5%, blank; 120 refused", (parseImportPct("5") as any).pct === 5 && (parseImportPct("7.5 %") as any).pct === 7.5 && (parseImportPct("") as any).pct === null && !parseImportPct("120").ok);
check("methods in words", (parseImportMethod("Bank Transfer") as any).method === "bank_transfer" && (parseImportMethod("CASH") as any).method === "cash" && (parseImportMethod("Credit card") as any).method === "card" && !parseImportMethod("bitcoin").ok);
const gE = guessImportColumns(EXPENSE_IMPORT_FIELDS, EXPENSE_IMPORT_FIELDS.map((f) => f.label));
check("the template's own headings map every expense field to its column", EXPENSE_IMPORT_FIELDS.every((f, i) => gE[f.key] === i), j(gE));
const gB = guessImportColumns(BILL_IMPORT_FIELDS, BILL_IMPORT_FIELDS.map((f) => f.label));
check("…and every bill field", BILL_IMPORT_FIELDS.every((f, i) => gB[f.key] === i), j(gB));
const gOther = guessImportColumns(EXPENSE_IMPORT_FIELDS, ["Expense Date", "Particulars", "Sub Category", "Expense Category", "Total Amount", "VAT"]);
check("other headings: subcategory not taken by category", gOther.date === 0 && gOther.description === 1 && gOther.subcategory === 2 && gOther.category === 3 && gOther.amount === 4 && gOther.taxPct === 5, j(gOther));

/* ── 2 ── */
step("2. Expense preview");
// Already on file, typed: the import repeats it.
const typed = await ex.createExpense(org, ME, {
  category: "travel_transport", subcategory: "business_taxi", description: "Existing taxi", expenseDate: "2026-01-20", amountMinor: 10_000, currency: "AED",
  categoryOther: "", taxPct: 0, taxInclusive: false, paymentAccount: "", reference: "", requiresApproval: false, isRecurring: false,
  attachments: [], projectName: "", costCentre: "", notes: "",
} as never);
const blank = { date: "", description: "", category: "", subcategory: "", amount: "", taxPct: "", currency: "", paidFrom: "", paymentMethod: "", reference: "", notes: "" };
const E = (row: number, x: Partial<typeof blank>) => ({ row, ...blank, ...x });
const taxi = { date: "15/01/2026", description: "Taxi to client", category: "Travel & Transportation", subcategory: "Business Taxi", amount: "105.00", taxPct: "5", reference: "R-1" };
const expenseRows = [
  E(2, taxi),
  E(3, { date: "16/01/2026", description: "Flight to Mumbai", category: "travel_transport", subcategory: "flights", amount: "1,050.00", paidFrom: "main bank" }),
  E(4, { ...taxi, category: "Travl", reference: "R-4" }),
  E(5, { ...taxi, subcategory: "", reference: "R-5" }),
  E(6, { ...taxi, subcategory: "Rocket", reference: "R-6" }),
  E(7, { ...taxi, paidFrom: "ADCB", reference: "R-7" }),
  E(8, { ...taxi, description: "taxi TO client (again)" }),
  E(9, { date: "20/01/2026", description: "existing TAXI", category: "Travel & Transportation", subcategory: "Business Taxi", amount: "100" }),
  E(10, { ...taxi, paidFrom: "USD Account", reference: "R-10" }),
  E(11, { ...taxi, paidFrom: "Old Bank", reference: "R-11" }),
  E(12, { date: "2026-02-03", description: "Tea and biscuits", category: "Sundry", amount: "42.50", paidFrom: "PETTY CASH", notes: "Pantry" }),
  E(13, { ...taxi, date: "31/02/2026", amount: "-5", reference: "R-13" }),
  E(14, { ...taxi, paymentMethod: "bitcoin", reference: "R-14" }),
  E(15, { date: "17-Jan-2026", description: "Software licence", category: "Software, IT & Communications", subcategory: "", amount: "200", currency: "usd", paidFrom: "USD Account" }),
  E(16, { date: "18/01/2026", description: "Card lunch", category: "Sundry", subcategory: "Lunch", amount: "60" }),
];
// Row 15's category has subcategories: it must be refused for having none.
const expInput = expenseImportSchema.parse({ dateFormat: "dmy", fileName: "expenses.csv", rows: expenseRows });
const before = await Expense.countDocuments({});
const ep = await expImport.previewExpenseImport(org, expInput);
const er = (n: number) => ep.rows.find((r) => r.row === n)!;
check("nothing written by the preview", (await Expense.countDocuments({})) === before && (await BankTransaction.countDocuments({ amountMinor: { $lt: 0 } })) === 0);
check("row 2 ok: 105.00 with 5% inside — 100.00 + 5.00, unpaid", er(2).status === "ok" && er(2).netMinor === 10_000 && er(2).taxMinor === 500 && er(2).totalMinor === 10_500 && er(2).currency === "AED" && !er(2).accountName, j(er(2)));
check("row 3 ok: slugs and an account named in another case; paid by transfer", er(3).status === "ok" && er(3).categoryName === "Travel & Transportation" && er(3).subcategoryName === "Flights" && er(3).accountName === "Main Bank" && er(3).paymentMethod === "bank_transfer" && er(3).totalMinor === 105_000, j(er(3)));
check("row 4: Category 'Travl' not found", er(4).status === "error" && /Category 'Travl' not found/.test(er(4).message ?? ""), j(er(4)));
check("row 5: Subcategory required for Travel & Transportation", er(5).status === "error" && /Subcategory required for Travel & Transportation/.test(er(5).message ?? ""), j(er(5)));
check("row 6: Subcategory 'Rocket' not found", er(6).status === "error" && /Subcategory 'Rocket' not found in Travel & Transportation/.test(er(6).message ?? ""), j(er(6)));
check("row 7: Account 'ADCB' not found", er(7).status === "error" && /Account 'ADCB' not found/.test(er(7).message ?? ""), j(er(7)));
check("row 8: a repeat of row 2 (same day, total, reference)", er(8).status === "duplicate" && er(8).duplicateOf?.row === 2 && /Same as row 2/.test(er(8).message ?? ""), j(er(8)));
check("row 9: already on file (same day, total, description in another case)", er(9).status === "duplicate" && er(9).duplicateOf?.number === typed.expenseNumber && /Already entered as EXP-/.test(er(9).message ?? ""), j(er(9)));
check("row 10: account in USD, expense in AED", er(10).status === "error" && /USD Account is in USD, this expense is in AED/.test(er(10).message ?? ""), j(er(10)));
check("row 11: account closed", er(11).status === "error" && /Old Bank is closed/.test(er(11).message ?? ""), j(er(11)));
check("row 12 ok: a category with no subcategories; petty cash → cash", er(12).status === "ok" && er(12).categoryName === "Sundry" && er(12).accountName === "Petty Cash" && er(12).paymentMethod === "cash" && er(12).date === "2026-02-03", j(er(12)));
check("row 13: every problem said — date and amount", er(13).status === "error" && /not a real date/.test(er(13).message ?? "") && /must be more than 0/.test(er(13).message ?? ""), j(er(13)));
check("row 14: unknown method", er(14).status === "error" && /Payment method "bitcoin"/.test(er(14).message ?? ""), j(er(14)));
check("row 15: no subcategory for a category that has them", er(15).status === "error" && /Subcategory required for Software, IT & Communications/.test(er(15).message ?? ""), j(er(15)));
check("row 16: a subcategory for a category that has none", er(16).status === "error" && /Sundry has no subcategories/.test(er(16).message ?? ""), j(er(16)));
check("counts: 3 ok, 2 duplicates, 10 errors", ep.counts.ok === 3 && ep.counts.duplicate === 2 && ep.counts.error === 10, j(ep.counts));
const usdRow = await expImport.previewExpenseImport(org, expenseImportSchema.parse({ rows: [E(2, { date: "01/17/2026", description: "Licence", category: "Sundry", amount: "200", currency: "usd", paidFrom: "usd account" })], dateFormat: "mdy" }));
check("mm/dd when asked; currency in lower case; a USD account for a USD row", usdRow.rows[0]!.status === "ok" && usdRow.rows[0]!.date === "2026-01-17" && usdRow.rows[0]!.currency === "USD" && usdRow.rows[0]!.accountName === "USD Account", j(usdRow.rows[0]));

/* ── 3 ── */
step("3. Expense import");
check("typed by hand, 15/01/2026 would ask a manager (a reason is required)", /give the reason/.test(await refusal(ex.createExpense(org, ME, {
  category: "sundry", description: "x", expenseDate: "2026-01-15", amountMinor: 100, categoryOther: "", taxPct: 0, taxInclusive: false, paymentAccount: "", reference: "",
  requiresApproval: false, isRecurring: false, attachments: [], projectName: "", costCentre: "", notes: "",
} as never, { userId: ME }))));
const ei = await expImport.importExpenses(org, ME, expInput);
const res = (n: number) => ei.rows.find((r) => r.row === n)!;
check("3 created, 2 skipped as repeats, 10 refused", ei.counts.created === 3 && ei.counts.duplicate === 2 && ei.counts.error === 10, j(ei.counts));
check("a batch id, like imp-20261111-a1b2c3", /^imp-\d{8}-[a-f0-9]{6}$/.test(ei.batchId), ei.batchId);
const x2 = await Expense.findById(res(2).id).lean<any>();
check("row 2: EXP number, approved, 100.00 + 5% = 105.00 (tax inside), unpaid, no account line", /^EXP-/.test(res(2).number ?? "") && x2?.status === "approved" && x2.amountMinor === 10_000 && x2.taxMinor === 500 && x2.totalMinor === 10_500 && x2.taxInclusive === true && !x2.paidOn && !x2.bankTransactionId && (await linesOf(res(2).id!)).length === 0, j(x2));
check("…its category, subcategory, reference, who, and the batch", x2?.category === "travel_transport" && x2.subcategory === "business_taxi" && x2.reference === "R-1" && x2.submittedByName === "Ivy Importer" && x2.importBatchId === ei.batchId, j(x2));
const x3 = await Expense.findById(res(3).id).lean<any>();
const l3 = await linesOf(res(3).id!);
check("row 3: paid on its date from Main Bank, with its money-out line", x3?.paidOn?.toISOString().slice(0, 10) === "2026-01-16" && String(x3.bankAccountId) === main.id && x3.paymentMethod === "bank_transfer" && l3.length === 1 && l3[0].amountMinor === -105_000 && String(l3[0].accountId) === main.id && l3[0].date.toISOString().slice(0, 10) === "2026-01-16", j({ x3, l3 }));
const x12 = await Expense.findById(res(12).id).lean<any>();
const l12 = await linesOf(res(12).id!);
check("row 12: paid in cash from Petty Cash, its line there; notes kept", x12?.paymentMethod === "cash" && String(x12.bankAccountId) === petty.id && l12.length === 1 && l12[0].amountMinor === -4_250 && x12.notes === "Pantry" && !x12.subcategory, j({ x12, l12 }));
check("row 8 skipped: the repeat of row 2, now made", res(8).status === "duplicate" && res(8).number === res(2).number && /Same as row 2/.test(res(8).message ?? ""), j(res(8)));
check("the errors carry their reasons", /Category 'Travl' not found/.test(res(4).message ?? "") && /Account 'ADCB' not found/.test(res(7).message ?? ""));
check("old dates, no late entry: none asked, none on the expenses", (await lateCount()) === 0 && !x2?.lateEntry && !x3?.lateEntry && !x12?.lateEntry);
check("Main Bank's balance went down by the flight", (await BankAccount.findById(main.id).lean<any>())?.currentBalanceMinor === 10_000_000 - 105_000);
const again = await expImport.importExpenses(org, ME, expInput);
check("imported again: nothing new — the 3 are repeats of what is on file", again.counts.created === 0 && again.counts.duplicate === 5 && [2, 3, 12].every((n) => /Already entered as EXP-/.test(again.rows.find((r) => r.row === n)?.message ?? "")), j(again.counts));
const chunked = await expImport.importExpenses(org, ME, expenseImportSchema.parse({ batchId: ei.batchId, rows: [E(30, { date: "05/03/2026", description: "Courier", category: "Sundry", amount: "15" })] }));
check("a later part of the same file keeps its batch", chunked.batchId === ei.batchId && (await Expense.findById(chunked.rows[0]!.id).lean<any>())?.importBatchId === ei.batchId, j(chunked));

/* ── 4 ── */
step("4. Bill preview");
const supplier = await createVendor(org, { name: "Example Supplies LLC", email: "accounts@supplier.e2e-import.test", phone: "+971400000000", currency: "AED" } as never);
// Its last bill was on Net 30; one more without a vendor number, to be repeated by date and total.
const earlierBill = await bills.createBill(org, {
  vendorId: supplier.id, billDate: "2026-01-05", dueDate: "2026-02-04", currency: "AED", category: "office_supplies", subcategory: "printing",
  lineItems: [{ description: "Toner", quantity: 1, unitPriceMinor: 30_000, discountPct: 0, taxPct: 0 }], notes: "", paymentTerms: "Net 30", requiresApproval: false,
} as never);
const blankB = { vendor: "", billNumber: "", billDate: "", dueDate: "", category: "", subcategory: "", description: "", amount: "", taxPct: "", currency: "", paidOn: "", paidFrom: "", paymentMethod: "", notes: "" };
const B = (row: number, x: Partial<typeof blankB>) => ({ row, ...blankB, ...x });
const paper = { vendor: "example supplies llc", billNumber: "INV-1", billDate: "10/01/2026", category: "Office Supplies & Pantry", subcategory: "Stationery", description: "Paper", amount: "1000", taxPct: "5" };
const fresh = { vendor: "New Vendor Co", billNumber: "NV-1", billDate: "2026-01-12", dueDate: "20/01/2026", category: "office_supplies", subcategory: "stationery", description: "Pens", amount: "500", paidOn: "12/01/2026", paidFrom: "Main Bank" };
const billRows = [
  B(2, paper),
  B(3, fresh),
  B(4, { ...paper, billNumber: "inv-1", description: "Paper again" }),
  B(5, { ...paper, billNumber: "INV-5", category: "Travl" }),
  B(6, { ...paper, billNumber: "INV-6", paidOn: "12/01/2026" }),
  B(7, { ...paper, billNumber: "INV-7", paidOn: "12/01/2026", paidFrom: "ADCB" }),
  B(8, { vendor: "Example Supplies LLC", billDate: "05/01/2026", category: "Office Supplies & Pantry", subcategory: "Printing", description: "Toner", amount: "300" }),
  B(9, { ...fresh, billNumber: "NV-2", description: "Markers", amount: "80", taxPct: "", paidOn: "", paidFrom: "", dueDate: "" }),
  B(10, { ...paper, billNumber: "INV-10", dueDate: "01/01/2026" }),
  B(11, { ...paper, billNumber: "INV-11", currency: "USD", paidOn: "11/01/2026", paidFrom: "Main Bank" }),
];
const billInput = billImportSchema.parse({ dateFormat: "dmy", fileName: "bills.xlsx", rows: billRows });
const [billsBefore, vendorsBefore] = [await Bill.countDocuments({}), await Vendor.countDocuments({})];
const bp = await billImport.previewBillImport(org, billInput, { canAddVendors: true });
const br = (n: number) => bp.rows.find((r) => r.row === n)!;
check("nothing written by the preview", (await Bill.countDocuments({})) === billsBefore && (await Vendor.countDocuments({})) === vendorsBefore);
check("row 2 ok: the vendor in any case; 1,000 + 5% = 1,050; due by its Net 30", br(2).status === "ok" && br(2).vendorName === "Example Supplies LLC" && !br(2).newVendor && br(2).totalMinor === 105_000 && br(2).taxMinor === 5_000 && br(2).currency === "AED" && br(2).dueDate === "2026-02-09", j(br(2)));
check("row 3 ok: a new vendor — will be added; paid from Main Bank by transfer", br(3).status === "ok" && br(3).newVendor === true && br(3).paidOn === "2026-01-12" && br(3).accountName === "Main Bank" && br(3).paymentMethod === "bank_transfer" && br(3).dueDate === "2026-01-20", j(br(3)));
check("the new vendors listed once", j(bp.newVendors) === j(["New Vendor Co"]), j(bp.newVendors));
check("row 4: a repeat of row 2 by bill number (any case)", br(4).status === "duplicate" && br(4).duplicateOf?.row === 2, j(br(4)));
check("row 5: Category 'Travl' not found", br(5).status === "error" && /Category 'Travl' not found/.test(br(5).message ?? ""), j(br(5)));
check("row 6: paid on without paid from", br(6).status === "error" && /Paid on is given without Paid from/.test(br(6).message ?? ""), j(br(6)));
check("row 7: Account 'ADCB' not found", br(7).status === "error" && /Account 'ADCB' not found/.test(br(7).message ?? ""), j(br(7)));
check("row 8: already on file — same vendor, date and total, no number on either", br(8).status === "duplicate" && br(8).duplicateOf?.number === earlierBill.billNumber, j(br(8)));
check("row 9 ok: the same new vendor, another number; due = bill date (a new vendor has no terms)", br(9).status === "ok" && br(9).newVendor === true && br(9).dueDate === "2026-01-12", j(br(9)));
check("row 10: due before the bill date", br(10).status === "error" && /before the bill date/.test(br(10).message ?? ""), j(br(10)));
check("row 11: a USD bill can't be paid from an AED account", br(11).status === "error" && /Main Bank is in AED, this bill is in USD/.test(br(11).message ?? ""), j(br(11)));
check("counts: 3 ok, 2 duplicates, 5 errors", bp.counts.ok === 3 && bp.counts.duplicate === 2 && bp.counts.error === 5, j(bp.counts));
const noVendors = await billImport.previewBillImport(org, billInput, { canAddVendors: false });
check("someone who can't add vendors: those rows refused, none listed", noVendors.rows.find((r) => r.row === 3)?.status === "error" && /can't add vendors/.test(noVendors.rows.find((r) => r.row === 3)?.message ?? "") && noVendors.newVendors.length === 0, j(noVendors.rows.find((r) => r.row === 3)));

/* ── 5 ── */
step("5. Bill import");
const bi = await billImport.importBills(org, ME, billInput, { canAddVendors: true });
const bres = (n: number) => bi.rows.find((r) => r.row === n)!;
check("3 created, 2 repeats, 5 refused", bi.counts.created === 3 && bi.counts.duplicate === 2 && bi.counts.error === 5, j({ counts: bi.counts, errors: bi.rows.filter((r) => r.status === "error").map((r) => r.row) }));
check("the new vendor added once", bi.newVendors.length === 1 && bi.newVendors[0]!.name === "New Vendor Co" && (await Vendor.countDocuments({ organizationId: ORG, name: "New Vendor Co" })) === 1, j(bi.newVendors));
const nv = await Vendor.findOne({ name: "New Vendor Co" }).lean<any>();
check("…with a stand-in email that never receives mail, in AED", /@no-email\.invalid$/.test(nv?.email ?? "") && nv.currency === "AED" && /^VEND-/.test(nv.vendorCode), j(nv));
const b2 = await Bill.findById(bres(2).id).lean<any>();
check("row 2: a BILL number, approved, one line, 1,050.00 owed, the vendor's number kept, due by Net 30", /^BILL-/.test(bres(2).number ?? "") && b2?.status === "approved" && b2.lineItems.length === 1 && b2.totalMinor === 105_000 && b2.balanceMinor === 105_000 && b2.reference === "INV-1" && b2.dueDate.toISOString().slice(0, 10) === "2026-02-09" && b2.paymentTerms === "Net 30", j(b2));
check("…who imported it, and the batch", String(b2?.createdById) === ME && b2.createdByName === "Ivy Importer" && b2.importBatchId === bi.batchId, j(b2));
const e2 = await Expense.findOne({ "source.key": `bill:${bres(2).id}` }).lean<any>();
check("…its own expense: net, VAT, total, category, approved, unpaid, by the importer", !!e2 && e2.amountMinor === 100_000 && e2.taxMinor === 5_000 && e2.totalMinor === 105_000 && e2.category === "office_supplies" && e2.subcategory === "stationery" && e2.status === "approved" && !e2.paidOn && e2.submittedByName === "Ivy Importer" && String(b2.expenseId) === String(e2._id), j(e2));
const b3 = await Bill.findById(bres(3).id).lean<any>();
const l3b = await linesOf(bres(3).id!);
check("row 3: paid in full on 12 Jan from Main Bank, its line there", b3?.status === "paid" && b3.payments.length === 1 && b3.payments[0].amountMinor === 50_000 && String(b3.payments[0].bankAccountId) === main.id && b3.payments[0].method === "bank_transfer" && b3.payments[0].reference === "NV-1" && l3b.length === 1 && l3b[0].amountMinor === -50_000, j({ b3, l3b }));
const e3 = await Expense.findOne({ "source.key": `bill:${bres(3).id}` }).lean<any>();
check("…its expense paid on that day, with no line of its own", e3?.paidOn?.toISOString().slice(0, 10) === "2026-01-12" && !e3.bankTransactionId, j(e3));
const b9 = await Bill.findById(bres(9).id).lean<any>();
check("row 9: on the vendor the import added", String(b9?.vendorId) === String(nv?._id) && b9.status === "approved" && b9.totalMinor === 8_000, j(b9));
check("old dates, no late entry: none asked, none on the bills or the payment", (await lateCount()) === 0 && !b2?.lateEntry && !b3?.lateEntry && !b3?.payments[0].lateEntry);
check("found by the vendor's number in the Bills search", (await bills.listBills(org, { q: "NV-2", page: 1, pageSize: 10 } as never)).data.map((b) => b.id).join() === bres(9).id && (await bills.getBill(org, bres(9).id!)).reference === "NV-2");
const billsAgain = await billImport.importBills(org, ME, billInput, { canAddVendors: true });
check("imported again: nothing new, no vendor added", billsAgain.counts.created === 0 && billsAgain.counts.duplicate === 5 && billsAgain.newVendors.length === 0 && (await Vendor.countDocuments({ name: "New Vendor Co" })) === 1, j(billsAgain.counts));

/* ── 6 ── */
step("6. The routes");
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api/v1/bills", billRoutes);
app.use("/api/v1/expenses", expenseRoutes);
app.use(notFound);
app.use(errorHandler);
const server = http.createServer(app);
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
const tokenWith = (perms: string[]) => signAccessToken({ sub: ME, org, role: "test", perms });
const post = async (path: string, perms: string[], body: unknown) => {
  const r = await fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenWith(perms)}` }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const oneExpense = { rows: [E(2, { date: "10/03/2026", description: "Route courier", category: "Sundry", amount: "12" })] };
check("expense preview without expense:create — 403", (await post("expenses/import/preview", ["expense:read", "expense:write:own"], oneExpense)).status === 403);
check("expense import without expense:create — 403, nothing made", (await post("expenses/import", ["expense:read"], oneExpense)).status === 403 && (await Expense.countDocuments({ description: "Route courier" })) === 0);
const okPreview = await post("expenses/import/preview", ["expense:create"], oneExpense);
check("with expense:create — the preview", okPreview.status === 200 && okPreview.body.data.counts.ok === 1, j(okPreview));
const tooMany = await post("expenses/import/preview", ["expense:create"], { rows: Array.from({ length: 1001 }, (_, i) => E(i + 2, { description: "x" })) });
check("1,001 rows refused", tooMany.status === 422 && /1000 rows/.test(j(tooMany.body)), j(tooMany));
const viaHttp = await post("expenses/import", ["expense:create"], oneExpense);
check("an import over HTTP makes it", viaHttp.status === 200 && viaHttp.body.data.counts.created === 1 && (await Expense.countDocuments({ description: "Route courier" })) === 1, j(viaHttp));
const oneBill = { rows: [B(2, { vendor: "Route Vendor", billDate: "10/03/2026", category: "Sundry", description: "Route bill", amount: "40" })] };
check("bill preview without bill:create — 403", (await post("bills/import/preview", ["bill:read", "vendor:create"], oneBill)).status === 403);
const noVendorRight = await post("bills/import/preview", ["bill:create"], oneBill);
check("bill:create without vendor:create — a new vendor's row refused", noVendorRight.status === 200 && noVendorRight.body.data.rows[0].status === "error" && /can't add vendors/.test(noVendorRight.body.data.rows[0].message), j(noVendorRight));
const billHttp = await post("bills/import", ["bill:create", "vendor:create"], oneBill);
check("with both — made over HTTP, the vendor added", billHttp.status === 200 && billHttp.body.data.counts.created === 1 && billHttp.body.data.newVendors[0]?.name === "Route Vendor", j(billHttp));
check("still no late entries", (await lateCount()) === 0);
server.close();

console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
