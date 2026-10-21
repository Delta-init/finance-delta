/**
 * Expense categories with subcategories (the user, 2026-10-21: the 17 categories and their subcategories, "create
 * category will have the subcategory also … remove the current categories … backfill the category and subcategory")
 * — finance's services in the test itself.
 *
 * What it proves:
 *   - a new organization starts with the 17 categories and their subcategories, the ones that are not expenses (staff
 *     advances, payroll clearing, VAT, loan principal) marked out of the profit and loss;
 *   - an expense needs one of its category's subcategories, and an edit keeps or changes it;
 *   - a category is created and edited with its subcategories: renamed ones keep their slug and rename their expenses,
 *     one in use cannot be removed, a new one never takes an old slug;
 *   - the P&L, the Daily Report and its breakdown, Expense by category and the dashboard leave out what is marked out,
 *     cash flow does not, and the switch on the category moves it back in;
 *   - the payouts' defaults (salary advance, one-time payment …) fill the subcategory, and a taxonomy category an
 *     organization does not have yet is added when one is filed under it;
 *   - the backfill: a dry run writes nothing; --write files every old expense (by origin, words, old category, else
 *     Pending Classification), keeps the old category on it, removes the old categories, reshapes a same-slug one;
 *     a second run finds nothing; the undo puts it all back.
 *
 * Run through scripts/expense-taxonomy-e2e.sh (throwaway mongod, no .env anywhere).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { EXPENSE_TAXONOMY, createExpenseCategorySchema, createExpenseSchema, updateExpenseSchema } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Role } = await import("../modules/role/role.model");
const { Expense } = await import("../modules/expense/expense.model");
const { ExpenseCategory } = await import("../modules/expense-category/expense-category.model");
const { CrmCommissionPayout } = await import("../modules/crm-commission/crm-commission-payout.model");
const ex = await import("../modules/expense/expense.service");
const cats = await import("../modules/expense-category/expense-category.service");
const reports = await import("../modules/reports/reports.service");
const dash = await import("../modules/dashboard/dashboard.service");
const mig = await import("./expense-taxonomy-migrate");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 600);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const ALL = { all: true } as const;

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", lateEntryDays: 0 });
const ORG = String(org._id);
const role = await Role.create({ organizationId: org._id, key: "accounts", name: "Accounts", permissions: [] });
const me = await User.create({
  name: "Accounts", email: "accounts@e2e-taxonomy.test", passwordHash: "x", status: "active",
  memberships: [{ organizationId: org._id, roleId: role._id, status: "active" }],
});
const ME = String(me._id);
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const expense = (over: Record<string, unknown>) => ex.createExpense(ORG, ME, createExpenseSchema.parse({
  description: "Spend", expenseDate: today, amountMinor: 10_000, currency: "AED", paymentMethod: "cash", ...over,
}) as never);

/* ── 1 ── */
step("1. A new organization starts with the taxonomy");
const list = await cats.listCategories(ORG);
check("17 categories, each with its subcategories", list.length === 17 && list.every((c) => c.subcategories.length >= 2), j(list.map((c) => [c.slug, c.subcategories.length])));
const off = list.filter((c) => !c.inPnl).map((c) => c.slug).sort();
check("out of the P&L: staff advances, payroll clearing, VAT", j(off) === j(["employee_advances", "payroll_payable", "vat_control"]), j(off));
const loan = list.find((c) => c.slug === "loan_financing")!;
check("Loan / Financing counts, its principal does not", loan.inPnl && loan.subcategories.find((s) => s.slug === "loan_principal")?.inPnl === false, j(loan));
check("the old seven are not there", !list.some((c) => ["other", "travel", "salaries_wages"].includes(c.slug)));

/* ── 2 ── */
step("2. An expense is filed under a subcategory");
check("none given: refused", /Pick a subcategory of Travel & Transport/.test(await refusal(expense({ category: "travel_transport" }))));
check("one of another category: refused", /not a subcategory of Travel & Transport/.test(await refusal(expense({ category: "travel_transport", subcategory: "office_rent" }))));
check("an old category: refused", /Unknown expense category "other"/.test(await refusal(expense({ category: "other" }))));
const taxi = await expense({ category: "travel_transport", subcategory: "business_taxi", description: "Uber to DIFC", amountMinor: 10_000 });
check("filed, with both names", taxi.category === "travel_transport" && taxi.subcategory === "business_taxi" && taxi.categoryName === "Travel & Transportation" && taxi.subcategoryName === "Business Taxi", j(taxi));
let e = await ex.updateExpense(ORG, taxi.id, updateExpenseSchema.parse({ description: "Uber to DIFC and back" }) as never, ALL);
check("an edit that leaves it out keeps it", e.subcategory === "business_taxi", j(e));
e = await ex.updateExpense(ORG, taxi.id, updateExpenseSchema.parse({ category: "travel_transport", subcategory: "parking" }) as never, ALL);
check("changed on an edit", e.subcategory === "parking" && e.subcategoryName === "Parking");
check("another category without a subcategory: refused", /Pick a subcategory of Office Supplies/.test(await refusal(ex.updateExpense(ORG, taxi.id, updateExpenseSchema.parse({ category: "office_supplies" }) as never, ALL))));
e = await ex.updateExpense(ORG, taxi.id, updateExpenseSchema.parse({ category: "travel_transport", subcategory: "business_taxi" }) as never, ALL);
const listed = await ex.listExpenses(ORG, { page: 1, pageSize: 50, subcategory: "business_taxi" } as never, ALL);
check("the list filters by subcategory", listed.data.length === 1 && listed.data[0]!.id === taxi.id, j(listed.data.map((x) => x.subcategory)));

/* ── 3 ── */
step("3. Creating and editing a category with its subcategories");
check("a category with no subcategory: refused by the form", !createExpenseCategorySchema.safeParse({ name: "Bare" }).success && !createExpenseCategorySchema.safeParse({ name: "Bare", subcategories: [] }).success);
const made = await cats.createCategory(ORG, { name: "Student Refunds", inPnl: true, subcategories: [{ name: "Course Refunds" }, { name: "Deposit Refunds", inPnl: false }] });
check("made with its subcategories, slugs from the names", j(made.subcategories.map((s) => [s.slug, s.inPnl ?? null])) === j([["course_refunds", null], ["deposit_refunds", false]]), j(made.subcategories));
const refund = await expense({ category: made.slug, subcategory: "course_refunds", description: "Refund — Ali" });
check("named twice: refused", /listed twice/.test(await refusal(cats.updateCategory(ORG, made.id, { name: "Student Refunds", subcategories: [{ name: "A" }, { name: "a" }] }))));
check("one in use removed: refused", /Cannot remove "Course Refunds" — it is used by 1 expense/.test(await refusal(cats.updateCategory(ORG, made.id, { name: "Student Refunds", subcategories: [{ slug: "deposit_refunds", name: "Deposit Refunds" }] }))));
const renamed = await cats.updateCategory(ORG, made.id, {
  name: "Refunds", subcategories: [{ slug: "course_refunds", name: "Programme Refunds" }, { name: "Deposit Refunds" }],
});
check("renamed: same slug; the one dropped and named again gets a new slug", j(renamed.subcategories.map((s) => s.slug)) === j(["course_refunds", "deposit_refunds_2"]), j(renamed.subcategories));
const rf = await ex.getExpense(ORG, refund.id, ALL);
check("the rename reaches its expenses", rf.categoryName === "Refunds" && rf.subcategoryName === "Programme Refunds", j(rf));
check("counts per subcategory", renamed.expenseCount === 1 && renamed.subcategories[0]!.expenseCount === 1, j(renamed));

/* ── 4 ── */
step("4. What is not an expense stays out of the profit and loss");
await Expense.deleteMany({ organizationId: org._id });
await expense({ category: "employee_advances", subcategory: "salary_advances", description: "Advance — Meera", amountMinor: 100_000 });
await expense({ category: "loan_financing", subcategory: "loan_principal", description: "Loan instalment", amountMinor: 50_000 });
await expense({ category: "loan_financing", subcategory: "interest_expense", description: "Loan interest", amountMinor: 5_000 });
await expense({ category: "travel_transport", subcategory: "business_taxi", description: "Taxi", amountMinor: 10_000 });
const pl = await reports.getProfitLoss(ORG, today, today);
check("P&L: interest and the taxi only", pl.expenses.total === 15_000, j(pl.expenses));
const daily = await reports.getDailyReport(ORG, today, today);
check("Daily Report: the same", daily.totals.expenseMinor === 15_000, j(daily.totals));
const bd = await reports.getDailyBreakdown(ORG, "expense", today, today);
check("…and its breakdown adds up to it, by subcategory too", bd.totalMinor === 15_000 && bd.count === 2 && bd.groups.some((g) => g.key === "subcategory" && g.items.some((i) => i.name === "Loan / Financing › Interest Expense")), j(bd.groups));
const byCat = await reports.getExpenseByCategory(ORG, today, today);
check("Expense by category: per subcategory, the same total", byCat.grandTotalMinor === 15_000 && byCat.categories.some((c) => c.category === "Travel & Transportation › Business Taxi"), j(byCat));
const d1 = await dash.getDashboardStats(ORG);
check("dashboard: profit this month leaves them out", d1.kpi.netProfitMtd === -15_000, j(d1.kpi));
const cf = await reports.getCashFlow(ORG, today, today);
check("cash flow keeps every one — the money went", cf.operating.outflows === 165_000, j(cf.operating));
const adv = list.find((c) => c.slug === "employee_advances")!;
await cats.updateCategory(ORG, adv.id, { name: adv.name, inPnl: true });
check("switched on, the advance counts", (await reports.getProfitLoss(ORG, today, today)).expenses.total === 115_000);
await cats.updateCategory(ORG, adv.id, { name: adv.name, inPnl: false });

/* ── 5 ── */
step("5. Payout defaults, and a taxonomy category added when needed");
const r1 = await cats.resolveExpenseCategory(ORG, "employee_advances", undefined, { fallbackSub: "salary_advances" });
check("a salary advance's default fills the subcategory", r1.subcategory === "salary_advances" && r1.subcategoryName === "Salary Advances", j(r1));
check("a default from another category does not", /Pick a subcategory of Rent & Utilities/.test(await refusal(cats.resolveExpenseCategory(ORG, "rent_utilities", undefined, { fallbackSub: "salary_advances" }))));
const legacy = await Organization.create({ name: "Not moved yet E2E", baseCurrency: "AED" });
await ExpenseCategory.create({ organizationId: legacy._id, slug: "other", name: "Other", isSystem: true });
const r2 = await cats.resolveExpenseCategory(String(legacy._id), "payroll_benefits", "basic_salary");
check("an organization without it: added, with its subcategories", r2.categoryName === "Payroll & Employee Benefits" && (await ExpenseCategory.countDocuments({ organizationId: legacy._id })) === 2, j(r2));
check("its old categories still work, no subcategory asked", (await cats.resolveExpenseCategory(String(legacy._id), "other", undefined)).subcategory === null);

/* ── 6 ── */
step("6. The backfill");
const old = await Organization.create({ name: "Old categories E2E", baseCurrency: "AED" });
const OLD = old._id;
await ExpenseCategory.insertMany([
  ...[["salaries_wages", "Salaries & Wages"], ["commissions", "Commissions"], ["rent", "Rent"], ["utilities", "Utilities"], ["travel", "Travel"], ["marketing", "Marketing"], ["other", "Other"]]
    .map(([slug, name]) => ({ organizationId: OLD, slug, name, isSystem: true })),
  { organizationId: OLD, slug: "software", name: "Software", isSystem: false },
  { organizationId: OLD, slug: "office_supplies", name: "Office Supplies", isSystem: false },
]);
const want: [string, string, string, string, Record<string, unknown>?][] = [
  // number, old category, description, where it should go
  ["EXP-1", "salaries_wages", "Salary Sept — Ahmed", "payroll_benefits/basic_salary"],
  ["EXP-2", "salaries_wages", "Salary advance — Rahul", "employee_advances/salary_advances", { source: { kind: "hrms_advance", key: "a1", hrmsOrgId: "h", requestId: "r1" } }],
  ["EXP-3", "salaries_wages", "Eid gift — Sana", "payroll_benefits/bonuses", { source: { kind: "hrms_one_time", key: "o1", hrmsOrgId: "h", requestId: "r2" } }],
  ["EXP-4", "travel", "Uber to client", "travel_transport/business_taxi"],
  ["EXP-5", "travel", "Careem food — lunch", "employee_reimbursements/staff_meals"],
  ["EXP-6", "travel", "Nol card recharge", "travel_transport/staff_commuting"],
  ["EXP-7", "travel", "Misc", "travel_transport/business_travel"],
  ["EXP-8", "marketing", "Meta boost October", "advertising_marketing/meta_ads"],
  ["EXP-9", "marketing", "Misc", "other_unclassified/pending_classification"],
  ["EXP-10", "rent", "October", "rent_utilities/office_rent"],
  ["EXP-11", "utilities", "DEWA September", "rent_utilities/electricity"],
  ["EXP-12", "other", "Plants for reception", "other_unclassified/pending_classification", { categoryName: "Office plants" }],
  ["EXP-13", "other", "A4 paper", "office_supplies/stationery"],
  ["EXP-14", "software", "Zoom annual", "software_it/software_subscriptions"],
  ["EXP-15", "office_supplies", "Tea and coffee", "office_supplies/pantry_supplies"],
  ["EXP-16", "commissions", "Team leader commission Sept", "sales_commission/team_leader_commission"],
  ["EXP-17", "other", "Old one", "other_unclassified/pending_classification", { status: "voided" }],
  ["EXP-18", "salaries_wages", "Sales commission — Ria (Sales CRM, 2026-09)", "sales_commission/team_leader_commission"],
  ["EXP-19", "salaries-wages", "Payroll PR-1 · 2026-09 · 3 people", "payroll_benefits/basic_salary"],
  ["EXP-20", "vegetables", "Vegetables for the pantry", "office_supplies/pantry_supplies", { categoryName: "Vegetables" }],
];
const ids = new Map<string, Types.ObjectId>();
for (const [n, cat, description, , over] of want) {
  const name = (over?.categoryName as string) ?? (await ExpenseCategory.findOne({ organizationId: OLD, slug: cat }))?.name ?? cat;
  const doc = await Expense.create({ organizationId: OLD, expenseNumber: n, category: cat, categoryName: name, description, expenseDate: new Date(today),
    amountMinor: 1_000, totalMinor: 1_000, submittedById: me._id, submittedByName: "Accounts", status: "approved", ...over });
  ids.set(n, doc._id);
}
await CrmCommissionPayout.create({ key: "delta:2026-09:ria", organizationId: OLD, crm: "delta", month: "2026-09", userId: "ria", personName: "Ria",
  amountMinor: 1_000, state: "paid", roles: ["tl"], approvedById: me._id, approvedAt: new Date(), expenseId: ids.get("EXP-18") });
// One already filed in the taxonomy organization (section 1) is left alone.
const before = await Expense.find({ organizationId: OLD }).lean();
const catsBefore = await ExpenseCategory.find({ organizationId: OLD }).sort({ slug: 1 }).lean();

const dry = await mig.migrateExpenseTaxonomy({ write: false });
const plan = dry.plans.find((p) => p.orgId === String(OLD))!;
check("the dry run: 16 to add, 1 to reshape, 20 expenses, 8 old categories to remove", plan.add.length === 16 && plan.reshape.length === 1 && plan.expenses.length === 20 && plan.remove.length === 8,
  j({ add: plan.add.length, reshape: plan.reshape, n: plan.expenses.length, remove: plan.remove.map((r) => r.slug) }));
check("…and nothing for an organization already on the taxonomy — its own category made since kept", dry.plans.find((p) => p.orgId === ORG)!.expenses.length === 0 && dry.plans.find((p) => p.orgId === ORG)!.remove.length === 0, j(dry.plans.find((p) => p.orgId === ORG)));
const wrong = want.filter(([n, , , to]) => plan.expenses.find((x) => x.number === n)?.to.join("/") !== to);
check("each filed where it belongs", wrong.length === 0, j(wrong.map(([n, , , to]) => [n, to, plan.expenses.find((x) => x.number === n)])));
check("the dry run wrote nothing", j(await Expense.find({ organizationId: OLD }).lean()) === j(before) && (await ExpenseCategory.countDocuments({ organizationId: OLD })) === 9);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taxonomy-e2e-"));
const done = await mig.migrateExpenseTaxonomy({ write: true, backupDir: dir });
check("written, with a backup", !!done.backup && fs.existsSync(done.backup!), j(done.backup));
const nowCats = await ExpenseCategory.find({ organizationId: OLD }).lean<any[]>();
check("the organization's categories are now exactly the 17", j(nowCats.map((c) => c.slug).sort()) === j(EXPENSE_TAXONOMY.map((c) => c.slug).sort()), j(nowCats.map((c) => c.slug)));
const os1 = nowCats.find((c) => c.slug === "office_supplies");
check("the hand-made one of the same slug takes the taxonomy's name and subcategories", os1?.name === "Office Supplies & Pantry" && os1?.subcategories?.length === 4 && String(os1?._id) === String(catsBefore.find((c: any) => c.slug === "office_supplies")!._id), j(os1));
const after = await ex.getExpense(String(OLD), String(ids.get("EXP-12")), ALL);
check("an expense filed: the new names, its old category kept and shown", after.category === "other_unclassified" && after.subcategoryName === "Pending Classification" && after.legacyCategoryName === "Office plants", j(after));
const statuses = await Expense.find({ organizationId: OLD, expenseNumber: "EXP-17" }).lean<any[]>();
check("a voided one too, still voided", statuses[0]?.category === "other_unclassified" && statuses[0]?.status === "voided", j(statuses[0]));
const again = await mig.migrateExpenseTaxonomy({ write: false });
check("a second run finds nothing", again.plans.every((p) => !p.add.length && !p.reshape.length && !p.expenses.length && !p.remove.length), j(again.plans));

const undoDry = await mig.undoExpenseTaxonomy(done.backup!, false);
check("the undo without --write writes nothing", undoDry.length >= 1 && (await ExpenseCategory.countDocuments({ organizationId: OLD })) === 17);
await mig.undoExpenseTaxonomy(done.backup!, true);
const restored = await Expense.find({ organizationId: OLD }).lean();
const strip = (rows: any[]) => rows.map(({ updatedAt, ...r }) => r);
check("the undo: every expense as it was", j(strip(restored)) === j(strip(before)), j(strip(restored).find((r: any, i) => j(r) !== j(strip(before)[i]))));
const catsRestored = await ExpenseCategory.find({ organizationId: OLD }).sort({ slug: 1 }).lean();
check("…and the categories as they were", j(catsRestored.map((c: any) => [String(c._id), c.slug, c.name, c.subcategories?.length ?? 0])) === j(catsBefore.map((c: any) => [String(c._id), c.slug, c.name, c.subcategories?.length ?? 0])),
  j(catsRestored.map((c: any) => [c.slug, c.name])));
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} passed\x1b[0m`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
