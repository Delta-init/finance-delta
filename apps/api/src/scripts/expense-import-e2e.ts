/**
 * The old books' expenses brought in (the user, 2026-10-21) — scripts/expense-import.ts against a scratch database.
 *
 * What it proves:
 *   - a dry run writes nothing, and says what it would add: the subcategories, the rows per category, the rows finance
 *     already has (same day and total — skipped), the repeats (imported too);
 *   - a row the organization has no place for, or in another currency, stops it before anything is written;
 *   - written: each row an approved, paid expense on its own date, numbered HX- oldest first, created on that date,
 *     filed where the data says, the old account and notes kept, INR rows in the INR organization; never in a bank book;
 *   - the subcategories it adds are out of the P&L, so partner shares and intercompany payments are not costs;
 *   - imported rows stay off the Approvals list, the "entered late" views and the salesperson pages, and "needs review"
 *     finds them in the Expenses list search;
 *   - a second run adds nothing; the undo takes out exactly what it added — finance's own expense stays.
 *
 * Run through scripts/expense-import-e2e.sh (throwaway mongod, no .env anywhere).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Role } = await import("../modules/role/role.model");
const { Department } = await import("../modules/department/department.model");
const { Employee } = await import("../modules/employee/employee.model");
const { Expense } = await import("../modules/expense/expense.model");
const { ExpenseCategory } = await import("../modules/expense-category/expense-category.model");
const { ensureDefaults } = await import("../modules/expense-category/expense-category.service");
const ex = await import("../modules/expense/expense.service");
const reports = await import("../modules/reports/reports.service");
const people = await import("../modules/payroll/people-report.service");
const { approvalList } = await import("../modules/approvals/approvals.service");
const { backdatedIn } = await import("../modules/integrations/portal-watch.service");
const imp = await import("./expense-import");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 500);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const ALL = { all: true } as const;

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const hq = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", lateEntryDays: 0 });
const blr = await Organization.create({ name: "Delta Banglore E2E", baseCurrency: "INR", lateEntryDays: 0 });
const HQ = String(hq._id), BLR = String(blr._id);
// Organizations from before this change: their Other / Unclassified has no partner or intercompany subcategory.
for (const o of [HQ, BLR]) {
  await ensureDefaults(o);
  await ExpenseCategory.updateOne({ organizationId: new Types.ObjectId(o), slug: "other_unclassified" },
    { $pull: { subcategories: { slug: { $in: ["partner_distributions", "intercompany_investments"] } } } });
}
const role = await Role.create({ organizationId: hq._id, key: "accounts", name: "Accounts", permissions: [] });
const sales = await Department.create({ organizationId: hq._id, name: "Sales" });
const farhan = await User.create({ name: "Farhan", email: "farhan@e2e-import.test", passwordHash: "x", status: "active", isSuperAdmin: true,
  memberships: [{ organizationId: hq._id, roleId: role._id, status: "active" }, { organizationId: blr._id, roleId: role._id, status: "active" }] });
await Employee.create({ organizationId: hq._id, hrmsOrgId: "h1", hrmsEmployeeId: "E1", employeeCode: "E1", name: "Farhan", userId: farhan._id, status: "active", departmentId: sales._id });

// Finance's own expense, which the old books also have (row 9): skipped, never counted twice.
const mine = await ex.createExpense(HQ, String(farhan._id), {
  category: "employee_advances", subcategory: "salary_advances", description: "Salary advance — Anfas", expenseDate: "2026-10-12",
  amountMinor: 150_000, currency: "AED", paymentMethod: "cash", taxPct: 0, taxInclusive: false, categoryOther: "",
} as never);
// And one of his own that is a cost, for the salesperson page.
await ex.createExpense(HQ, String(farhan._id), {
  category: "travel_transport", subcategory: "business_taxi", description: "Taxi", expenseDate: "2025-01-02",
  amountMinor: 5_000, currency: "AED", paymentMethod: "cash", taxPct: 0, taxInclusive: false, categoryOther: "",
} as never);

const row = (n: number, over: Partial<import("./expense-import").ImportRow>): import("./expense-import").ImportRow => ({
  row: n, org: "aed", date: "2024-05-10", description: `Row ${n}`, currency: "AED", totalMinor: 10_000, category: "office_supplies",
  subcategory: "stationery", why: "test", account: "Office Supplies", paidThrough: "Cash", paymentMethod: "cash", needsReview: false,
  notes: `Imported from the old books (Expense_2 export, row ${n}).`, ...over,
});
const data = {
  batch: "expense2-e2e", source: "e2e.xlsx",
  subcategoriesToAdd: [
    { category: "other_unclassified", slug: "partner_distributions", name: "Partner Distributions", inPnl: false },
    { category: "other_unclassified", slug: "intercompany_investments", name: "Intercompany & Investments", inPnl: false },
  ],
  rows: [
    row(2, { date: "2023-09-05", description: "Vishnu Share As WPS", totalMinor: 1_400_000, category: "other_unclassified", subcategory: "partner_distributions", account: "Share", paidThrough: "Reserve Fund", paymentMethod: null }),
    row(3, { date: "2024-07-27", description: "credit to delta destinations", totalMinor: 1_000_000, category: "other_unclassified", subcategory: "intercompany_investments", account: "Delta Destination-Investment" }),
    row(4, { date: "2024-01-15", description: "NG Salary", totalMinor: 100_000, category: "payroll_benefits", subcategory: "basic_salary", account: "Salary and Wages", paidThrough: "Salary payable", paymentMethod: null,
      needsReview: true, notes: "[Needs review] Imported from the old books (Expense_2 export, row 4).\nReview: Review — Check whether amount was previously accrued" }),
    row(5, { date: "2024-01-15", description: "Aswaaq", totalMinor: 10_000 }),
    row(6, { date: "2024-01-15", description: "Aswaaq", totalMinor: 10_000 }), // the same again — a repeat, imported too
    row(7, { date: "2025-03-01", description: "Facebook meta exp", totalMinor: 12_401, category: "advertising_marketing", subcategory: "meta_ads", account: "Advertising & Marketing", paidThrough: "ADCB BANK", paymentMethod: "bank_transfer" }),
    row(8, { org: "inr", date: "2025-06-30", description: "Bangalore office rent", currency: "INR", totalMinor: 4_500_000, category: "rent_utilities", subcategory: "office_rent", account: "Rent Expense", paidThrough: "Indian Office", paymentMethod: null }),
    row(9, { date: "2026-10-12", description: "Anfas salary advance", totalMinor: 150_000, category: "employee_advances", subcategory: "salary_advances", account: "Salary Advance" }),
    row(10, { date: "2023-09-04", description: "Office Cleaning (no description in the old books)", totalMinor: 64_000, category: "rent_utilities", subcategory: "other_utilities", account: "Office Cleaning" }),
  ],
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expense-import-e2e-"));
const file = path.join(dir, "data.json");
fs.writeFileSync(file, JSON.stringify(data));
const opts = { file, orgAed: HQ, orgInr: BLR, backupDir: dir };
const before = await Expense.countDocuments();

/* ── 1 ── */
step("1. The dry run");
let plan = await imp.importExpenses({ ...opts, write: false });
const pHq = plan.orgs.find((o) => o.orgId === HQ)!, pBlr = plan.orgs.find((o) => o.orgId === BLR)!;
check("entered as the first super admin", plan.by === "Farhan", plan.by);
check("HQ: both subcategories to add, 7 of its 8 rows to import", j(pHq.subcategoriesToAdd) === j(["other_unclassified › Partner Distributions", "other_unclassified › Intercompany & Investments"]) && pHq.toImport.length === 7, j(pHq.toImport.map((r) => r.row)));
check("…row 9 skipped: finance has an expense that day for that total, named", pHq.overlaps.length === 1 && pHq.overlaps[0]!.row === 9 && pHq.overlaps[0]!.matches.startsWith(mine.expenseNumber), j(pHq.overlaps));
check("…the repeat counted, and imported too", pHq.repeats === 1);
check("Banglore: its INR row", pBlr.toImport.length === 1 && pBlr.toImport[0]!.row === 8 && !pBlr.subcategoriesToAdd.length, j(pBlr));
check("10 changes in all (2 subcategories + 7 + 1)", imp.countOf(plan) === 2 + 7 + 1, String(imp.countOf(plan)));
check("…and nothing written", (await Expense.countDocuments()) === before && !(await ExpenseCategory.exists({ organizationId: hq._id, "subcategories.slug": "partner_distributions" })));

/* ── 2 ── */
step("2. Rows with no place stop it");
const badFile = path.join(dir, "bad.json");
fs.writeFileSync(badFile, JSON.stringify({ ...data, rows: [row(20, { subcategory: "no_such" }), row(21, { org: "inr", currency: "AED" })] }));
const bad = await imp.importExpenses({ ...opts, file: badFile, write: true });
check("a subcategory the organization lacks, and a currency it doesn't keep: said, nothing written",
  bad.orgs.some((o) => o.problems.some((p) => /has no office_supplies › no_such/.test(p))) && bad.orgs.some((o) => o.problems.some((p) => /row 21: AED, but .* keeps INR/.test(p)))
  && (await Expense.countDocuments()) === before && !bad.backup, j(bad.orgs.map((o) => o.problems)));
fs.writeFileSync(badFile, "{}");
check("a file that is not import data: refused", /not an import data file/.test(await refusal(imp.importExpenses({ ...opts, file: badFile, write: false }))));

/* ── 3 ── */
step("3. Written");
plan = await imp.importExpenses({ ...opts, write: true });
check("a backup of what it added", !!plan.backup && fs.existsSync(plan.backup!), j(plan.backup));
const rows = await Expense.find({ "source.kind": "import" }).sort({ expenseNumber: 1 }).lean<any[]>();
check("8 imported: 7 in HQ, 1 in Banglore", rows.length === 8 && rows.filter((r) => String(r.organizationId) === HQ).length === 7, String(rows.length));
const hqRows = rows.filter((r) => String(r.organizationId) === HQ);
check("numbered HX- oldest first", j(hqRows.map((r) => [r.expenseNumber, r.expenseDate.toISOString().slice(0, 10)]).slice(0, 3)) === j([["HX-00001", "2023-09-04"], ["HX-00002", "2023-09-05"], ["HX-00003", "2024-01-15"]]), j(hqRows.map((r) => r.expenseNumber)));
const share = hqRows.find((r) => r.description === "Vishnu Share As WPS");
check("approved and paid on its own date, created on it too, never in a bank book",
  share?.status === "approved" && share.paidOn?.toISOString().startsWith("2023-09-05") && share.createdAt?.toISOString().startsWith("2023-09-05") && !share.bankAccountId && share.paymentAccount === "Reserve Fund", j(share));
check("…filed where the data says, with the names, the old account and the notes",
  share?.categoryName === "Other / Unclassified" && share.subcategoryName === "Partner Distributions" && share.legacyCategory?.name === "Share" && /row 2/.test(share.notes), j(share));
const inr = rows.find((r) => String(r.organizationId) === BLR);
check("the INR row in Banglore, in INR", inr?.currency === "INR" && inr.totalMinor === 4_500_000 && inr.expenseNumber === "HX-00001", j(inr));
const cat = await ExpenseCategory.findOne({ organizationId: hq._id, slug: "other_unclassified" }).lean<any>();
check("the subcategories added, out of the P&L", j(cat.subcategories.filter((s: any) => s.inPnl === false).map((s: any) => s.slug)) === j(["partner_distributions", "intercompany_investments"]), j(cat.subcategories));
const dto = await ex.getExpense(HQ, String(share!._id), ALL);
check("the expense page reads it: Paid, the old account shown", dto.paymentStatus === "paid" && dto.legacyCategoryName === "Share" && dto.subcategoryName === "Partner Distributions", j(dto));

/* ── 4 ── */
step("4. Reports and lists");
const pl = await reports.getProfitLoss(HQ, "2023-01-01", "2025-12-31");
// In the P&L: salary 1000, Aswaaq 100 ×2, meta 124.01, cleaning 640, Farhan's taxi 50 — not the share (14,000) or the intercompany (10,000).
check("P&L: partner shares and intercompany payments are not costs", pl.expenses.total === 100_000 + 20_000 + 12_401 + 64_000 + 5_000, j(pl.expenses));
const approvals = await approvalList({ userId: String(farhan._id), organizationId: HQ, role: "", permissions: [], isSuperAdmin: true } as never, { status: "approved", page: 1, pageSize: 100 } as never);
check("never on the Approvals list", !approvals.rows.some((r) => /^HX-/.test(String(r.subtitle ?? ""))), j(approvals.rows.map((r) => r.subtitle)));
const late = await backdatedIn({ _id: hq._id, name: hq.name }, new Date(Date.now() - 400 * 86_400_000));
check("never in the entered-late views", !late.some((r) => /^HX-/.test(String((r as { number?: string }).number ?? ""))), j(late));
const report = await people.peopleReport(HQ, { from: "2023-01-01", to: "2026-12-31" } as never);
check("not counted against whoever ran it on the salesperson pages (Farhan: only his own 50 taxi)", report.rows.find((r: any) => r.name === "Farhan")?.expensesMinor === 5_000, j(report.rows));
const found = await ex.listExpenses(HQ, { page: 1, pageSize: 50, q: "needs review" } as never, ALL);
check("\"needs review\" finds the rows to review", found.data.length === 1 && found.data[0]!.description === "NG Salary", j(found.data.map((r) => r.description)));

/* ── 5 ── */
step("5. Again, and the undo");
const again = await imp.importExpenses({ ...opts, write: false });
check("a second run adds nothing: 8 imported before", imp.countOf(again) === 0 && again.orgs.reduce((n, o) => n + o.already, 0) === 8, j(again.orgs.map((o) => [o.already, o.toImport.length])));
const undoDry = await imp.undoImport(plan.backup!, false);
check("the undo without --write takes nothing out", (await Expense.countDocuments({ "source.kind": "import" })) === 8 && undoDry.length === 2, j(undoDry));
await imp.undoImport(plan.backup!, true);
check("the undo: every imported row out, finance's own expense stays", (await Expense.countDocuments({ "source.kind": "import" })) === 0 && !!(await Expense.exists({ _id: mine.id })));
const after = await ExpenseCategory.findOne({ organizationId: hq._id, slug: "other_unclassified" }).lean<any>();
check("…the subcategories it added out again", !after.subcategories.some((s: any) => ["partner_distributions", "intercompany_investments"].includes(s.slug)), j(after.subcategories));
const redo = await imp.importExpenses({ ...opts, write: true });
const first = await Expense.findOne({ organizationId: hq._id, "source.kind": "import" }).sort({ expenseNumber: 1 }).lean<any>();
check("imported again after the undo: numbering from HX-00001 again", first?.expenseNumber === "HX-00001" && imp.countOf(redo) === 10, j([first?.expenseNumber, imp.countOf(redo)]));

/* ── 6 ── */
step("6. From the raw exports (2026-10-22): the old books' ids, VAT, and never two imports at once");
const rawRow = (key: string, over: Partial<import("./expense-import").ImportRow>) => row(0, { key, notes: `Imported from the old books (Zoho expense, id ${key}).`, ...over });
const raw = {
  batch: "zoho-expenses-e2e", source: ["Expense (5).xlsx", "Expense (7).xlsx"], subcategoriesToAdd: data.subcategoriesToAdd,
  rows: [
    rawRow("zoho-exp:R1:aaaa:1", { row: 1, date: "2024-02-29", description: "muthu feb salary", totalMinor: 125_000, category: "payroll_benefits", subcategory: "basic_salary", account: "Salary and Wages" }),
    rawRow("zoho-exp:R1:bbbb:1", { row: 2, date: "2024-02-29", description: "muthu feb commission", totalMinor: 68_000, category: "sales_commission", subcategory: "sales_commission", account: "Sales Commission" }),
    rawRow("zoho-exp:R2:cccc:1", { row: 3, date: "2023-11-02", description: "Office supplies", totalMinor: 67_500, taxMinor: 3_214, taxPct: 5, reference: "237028" }),
  ],
};
const rawFile = path.join(dir, "raw.json");
fs.writeFileSync(rawFile, JSON.stringify(raw));
const blocked = await imp.importExpenses({ ...opts, file: rawFile, write: true });
const hqBlocked = blocked.orgs.find((o) => o.orgId === HQ)!;
check("the earlier import still here: refused, saying so, nothing written",
  hqBlocked.otherImports === 7 && hqBlocked.problems.some((p) => /another import are still here/.test(p)) && !blocked.backup
  && (await Expense.countDocuments({ "source.key": /^import:zoho-exp:/ })) === 0, j(hqBlocked.problems));
await imp.undoImport(redo.backup!, true);
const rawDone = await imp.importExpenses({ ...opts, file: rawFile, write: true });
const rawRows = await Expense.find({ "source.key": /^import:zoho-exp:/ }).sort({ expenseNumber: 1 }).lean<any[]>();
check("once it is out: the 3 lines, each with its own amount (the split salary + commission as 1,250 and 680)",
  rawRows.length === 3 && j(rawRows.filter((r) => /muthu/.test(r.description)).map((r) => r.totalMinor).sort()) === j([125_000, 68_000].sort()), j(rawRows.map((r) => [r.description, r.totalMinor])));
const vat = rawRows.find((r) => r.reference === "237028");
check("VAT as the old books had it: 675 with 32.14 inside, the reference kept",
  vat?.totalMinor === 67_500 && vat?.taxMinor === 3_214 && vat?.amountMinor === 64_286 && vat?.taxPct === 5 && vat?.taxInclusive === true, j(vat));
check("keyed by the old books' id", rawRows.every((r) => /^import:zoho-exp:R[12]:/.test(r.source.key)), j(rawRows.map((r) => r.source.key)));
const newer = { ...raw, batch: "zoho-expenses-e2e-newer", rows: [...raw.rows,
  rawRow("zoho-exp:R3:dddd:1", { row: 4, date: "2026-10-12", description: "meta", totalMinor: 2_770, category: "advertising_marketing", subcategory: "meta_ads", account: "Advertising & Marketing" })] };
const newerFile = path.join(dir, "newer.json");
fs.writeFileSync(newerFile, JSON.stringify(newer));
const more = await imp.importExpenses({ ...opts, file: newerFile, write: false });
const hqMore = more.orgs.find((o) => o.orgId === HQ)!;
check("a newer export (another batch): the 3 already in, only the new line to add — not refused as another import",
  hqMore.already === 3 && hqMore.toImport.length === 1 && !hqMore.problems.length && hqMore.otherImports === 0, j([hqMore.already, hqMore.toImport.length, hqMore.problems]));
void rawDone;

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} passed\x1b[0m`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
