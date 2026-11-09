/**
 * Budgets by expense category (2026-11-09), against a real API over HTTP:
 *   - every spending category of the month, budgeted or not, in the organization's currency (another currency only
 *     where something was spent in it); advances, payroll clearing, VAT and loan principal left out;
 *   - spent = approved expenses dated that month in the category, with a department or without; drafts, other
 *     months and other organizations left out; an expense with no subcategory under "No subcategory";
 *   - a budget for a whole category, or for a subcategory; a category's budget is its own, else its subcategories'
 *     added up; 0 takes it off; every change kept; two first saves at once make one budget;
 *   - a year adds up the months;
 *   - refused: what isn't spending, an unknown category or subcategory, a bad amount or month;
 *   - who: budget:manage sets, budget:read sees, a department's own reader neither;
 *   - the department allocations untouched.
 *
 * Run through scripts/category-budget-e2e.sh (throwaway mongod and API). Refuses anything but a scratch database.
 */
import mongoose from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Department } from "../modules/department/department.model";
import { Expense } from "../modules/expense/expense.model";
import { CategoryBudgetModel } from "../modules/budget/budget.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/[^/?]*e2e/.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const PORT = process.env.E2E_API_PORT ?? "4153";
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = "E2ePassword1!";
const OCT = "2026-10";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail = "") {
  checks++;
  if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(name: string) { console.log(`\n\x1b[1m${name}\x1b[0m`); }
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);

async function request(method: string, p: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function login(email: string): Promise<string> {
  const r = await request("POST", "/auth/login", { email, password: PASSWORD });
  const token = r.body?.data?.accessToken as string | undefined;
  if (!token) throw new Error(`login failed for ${email}: ${show(r)}`);
  return token;
}

async function main() {
  await mongoose.connect(uri);
  if (mongoose.connection.host !== "127.0.0.1" || !/e2e/.test(mongoose.connection.db!.databaseName)) {
    console.error(`Refusing to run: connected to ${mongoose.connection.host}/${mongoose.connection.db!.databaseName}`);
    process.exit(1);
  }

  step("An organization, its people, and October's expenses");
  const org = await Organization.create({ name: "Category Budget E2E", baseCurrency: "AED" });
  const other = await Organization.create({ name: "Somewhere Else", baseCurrency: "AED" });
  for (const def of SYSTEM_ROLES) {
    await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const roleId = (key: string) => roles.find((r) => r.key === key)!._id;
  const marketing = await Department.create({ organizationId: org._id, name: "Marketing" });
  const passwordHash = await hashPassword(PASSWORD);
  const person = (name: string, role: string, extra: Record<string, unknown> = {}) => User.create({
    name, email: `${name.toLowerCase()}@e2e-catbudget.test`, passwordHash, status: "active",
    memberships: [{ organizationId: org._id, roleId: roleId(role), status: "active", ...extra }],
  });
  const acc = await person("Accountant", "accountant");
  await person("Manager", "manager");
  await person("Staff", "employee", { departmentId: marketing._id });
  const accountant = await login("accountant@e2e-catbudget.test");
  const manager = await login("manager@e2e-catbudget.test");
  const staff = await login("staff@e2e-catbudget.test");

  let n = 0;
  const spend = (category: string, subcategory: string | null, totalMinor: number, over: Record<string, unknown> = {}) => Expense.create({
    organizationId: org._id, expenseNumber: `EXP-${++n}`, category, subcategory, description: `Spend ${n}`,
    expenseDate: new Date("2026-10-15T08:00:00Z"), amountMinor: totalMinor, totalMinor, currency: "AED",
    submittedById: acc._id, submittedByName: "Accountant", status: "approved", ...over,
  });
  await spend("rent_utilities", "office_rent", 3_000_000);                                  // 30,000, no department
  await spend("rent_utilities", "electricity", 200_000, { departmentId: marketing._id });   // 2,000, Marketing
  await spend("rent_utilities", null, 30_000);                                             // 300, no subcategory
  await spend("rent_utilities", "office_rent", 500_000, { status: "submitted" });          // not approved: out
  await spend("rent_utilities", "office_rent", 100_000, { expenseDate: new Date("2026-09-10T08:00:00Z") }); // September
  await spend("advertising_marketing", "meta_ads", 1_000_000);                             // 10,000
  await spend("employee_advances", "salary_advances", 400_000);                            // not spending: out
  await spend("loan_financing", "loan_principal", 700_000);                                // not spending: out
  await spend("loan_financing", "interest_expense", 50_000);                               // 500
  await spend("travel_transport", "flights", 5_000_000, { currency: "INR" });              // ₹50,000
  await Expense.create({ organizationId: other._id, expenseNumber: "EXP-X", category: "rent_utilities", subcategory: "office_rent", description: "Elsewhere",
    expenseDate: new Date("2026-10-15T08:00:00Z"), amountMinor: 9_999_900, totalMinor: 9_999_900, currency: "AED", submittedById: acc._id, submittedByName: "X", status: "approved" });

  const month = async (token = accountant, q = `month=${OCT}`) => request("GET", `/budgets/categories?${q}`, undefined, token);
  const rowOf = (rows: any[], category: string, currency = "AED") => rows.find((r) => r.category === category && r.currency === currency);
  const lineOf = (row: any, sub: string) => row?.subcategories?.find((s: any) => s.subcategory === sub);
  const set = (body: Record<string, unknown>, token = accountant) =>
    request("PATCH", "/budgets/category-allocations", { period: OCT, currency: "AED", note: "", ...body }, token);

  step("October by category — nothing budgeted yet");
  const first = await month();
  const rows: any[] = first.body?.data ?? [];
  check("answers", first.status === 200 && Array.isArray(rows), show(first));
  const cats = rows.filter((r) => r.currency === "AED").map((r) => r.category);
  check("every spending category in AED, budgeted or not (14 of the 17)", cats.length === 14 && cats.includes("bank_fees") && cats.includes("office_supplies"), j(cats));
  check("…not advances, payroll clearing or VAT", !cats.includes("employee_advances") && !cats.includes("payroll_payable") && !cats.includes("vat_control"), j(cats));
  const rent = rowOf(rows, "rent_utilities");
  check("Rent & Utilities: spent 32,300 — with a department or without, not the draft, not September, not the other organization",
    rent?.spentMinor === 3_230_000 && rent?.expenses === 3, j(rent));
  check("…no budget yet", rent?.budgeted === false && rent?.budgetFrom === "none" && rent?.allocatedMinor === 0, j(rent));
  check("…its subcategories: Office Rent 30,000, Electricity 2,000, and 300 under No subcategory",
    lineOf(rent, "office_rent")?.spentMinor === 3_000_000 && lineOf(rent, "electricity")?.spentMinor === 200_000
    && lineOf(rent, "")?.spentMinor === 30_000 && lineOf(rent, "")?.name === "No subcategory", j(rent?.subcategories));
  check("…every subcategory listed, spent in or not", !!lineOf(rent, "water") && lineOf(rent, "water").spentMinor === 0, j(rent?.subcategories?.map((s: any) => s.subcategory)));
  const loan = rowOf(rows, "loan_financing");
  check("Loan / Financing: the interest only (500) — the principal isn't spending, nor listed", loan?.spentMinor === 50_000 && !lineOf(loan, "loan_principal"), j(loan));
  check("travel spent in rupees: its own INR row", rowOf(rows, "travel_transport", "INR")?.spentMinor === 5_000_000 && rowOf(rows, "travel_transport")?.spentMinor === 0, j(rows.filter((r) => r.category === "travel_transport")));
  check("no other currency rows where nothing was spent", rows.filter((r) => r.currency !== "AED").length === 1, j(rows.filter((r) => r.currency !== "AED")));

  step("Budgets — a whole category, and subcategories");
  const r1 = await set({ category: "rent_utilities", allocatedMinor: 4_000_000, note: "Rent and bills" });
  check("Rent & Utilities given 40,000 — no department asked", r1.status === 200 && r1.body?.data?.category === "rent_utilities" && r1.body?.data?.subcategory === "" && r1.body?.data?.categoryName === "Rent & Utilities", show(r1));
  const m1 = (await month()).body?.data ?? [];
  const rent1 = rowOf(m1, "rent_utilities");
  check("…its row: budget 40,000, spent 32,300, left 7,700", rent1?.budgeted && rent1?.budgetFrom === "category" && rent1?.allocatedMinor === 4_000_000 && rent1?.availableMinor === 770_000, j(rent1));

  const a1 = await set({ category: "advertising_marketing", subcategory: "meta_ads", allocatedMinor: 600_000 });
  const a2 = await set({ category: "advertising_marketing", subcategory: "google_ads", allocatedMinor: 300_000 });
  check("Meta Ads 6,000 and Google Ads 3,000", a1.status === 200 && a2.status === 200 && a1.body?.data?.subcategoryName === "Meta Ads", `${show(a1)} | ${show(a2)}`);
  const m2 = (await month()).body?.data ?? [];
  const ads = rowOf(m2, "advertising_marketing");
  check("…Advertising's budget is what its subcategories add up to: 9,000, left −1,000", ads?.budgetFrom === "subcategories" && ads?.allocatedMinor === 900_000 && ads?.availableMinor === -100_000, j(ads));
  check("…Meta Ads: 6,000 budget, 10,000 spent, −4,000 left; Google Ads 3,000 left", lineOf(ads, "meta_ads")?.availableMinor === -400_000 && lineOf(ads, "google_ads")?.availableMinor === 300_000 && lineOf(ads, "google_ads")?.budgeted, j(ads?.subcategories));

  const e1 = await set({ category: "rent_utilities", subcategory: "electricity", allocatedMinor: 150_000 });
  const m3 = (await month()).body?.data ?? [];
  const rent3 = rowOf(m3, "rent_utilities");
  check("a subcategory budget under a budgeted category: the category's own 40,000 stays its budget", e1.status === 200 && rent3?.allocatedMinor === 4_000_000 && rent3?.budgetFrom === "category", j(rent3));
  check("…Electricity: 1,500 budget, 2,000 spent, −500", lineOf(rent3, "electricity")?.availableMinor === -50_000, j(lineOf(rent3, "electricity")));

  step("Changing and taking off");
  const r2 = await set({ category: "rent_utilities", allocatedMinor: 4_500_000, note: "Bills went up" });
  const listed = await request("GET", "/budgets/category-allocations?year=2026", undefined, accountant);
  const rentBudget = (listed.body?.data ?? []).find((b: any) => b.category === "rent_utilities" && b.subcategory === "" && b.period === OCT);
  check("raised to 45,000: one budget, both changes kept with their notes", r2.status === 200 && rentBudget?.allocatedMinor === 4_500_000 && rentBudget?.changes?.length === 2
    && rentBudget?.changes?.[1]?.note === "Bills went up" && rentBudget?.changes?.[1]?.changedByName === "Accountant", j(rentBudget));
  check("the year's list has the others too, with names", (listed.body?.data ?? []).some((b: any) => b.subcategory === "meta_ads" && b.subcategoryName === "Meta Ads" && b.categoryName === "Advertising & Marketing"), j(listed.body));
  const r3 = await set({ category: "rent_utilities", allocatedMinor: 0, note: "No budget after all" });
  const rent4 = rowOf((await month()).body?.data ?? [], "rent_utilities");
  check("set to 0: the category's own budget is off — what's left is its Electricity budget (1,500)", r3.status === 200 && rent4?.budgetFrom === "subcategories" && rent4?.allocatedMinor === 150_000, j(rent4));
  await set({ category: "rent_utilities", subcategory: "electricity", allocatedMinor: 0 });
  const rent5 = rowOf((await month()).body?.data ?? [], "rent_utilities");
  check("…and Electricity's to 0: no budget at all", rent5?.budgeted === false && rent5?.budgetFrom === "none" && lineOf(rent5, "electricity")?.budgeted === false, j(rent5));

  const race = await Promise.all([1, 2].map((i) => set({ category: "office_supplies", allocatedMinor: i * 100_000 })));
  const raced = await CategoryBudgetModel.find({ organizationId: org._id, category: "office_supplies" }).lean();
  check("two first saves at once: one budget, both changes kept", race.every((r) => r.status === 200) && raced.length === 1 && raced[0]!.changes.length === 2, `${race.map(show).join(" | ")} ${j(raced)}`);

  step("A year adds up its months");
  await set({ category: "rent_utilities", allocatedMinor: 4_000_000 });
  await set({ category: "rent_utilities", period: "2026-09", allocatedMinor: 1_000_000 });
  await set({ category: "rent_utilities", subcategory: "office_rent", period: "2026-08", allocatedMinor: 500_000 });
  const year = await month(accountant, "year=2026");
  const rentYear = rowOf(year.body?.data ?? [], "rent_utilities");
  check("2026: Rent's budget 40,000 + 10,000 + August's Office Rent 5,000 = 55,000; spent 33,300 with September's", year.status === 200 && rentYear?.period === "2026"
    && rentYear?.allocatedMinor === 5_500_000 && rentYear?.spentMinor === 3_330_000 && rentYear?.budgetFrom === "category", j(rentYear));
  check("…Office Rent's line: August's 5,000 budget, 31,000 spent", lineOf(rentYear, "office_rent")?.allocatedMinor === 500_000 && lineOf(rentYear, "office_rent")?.spentMinor === 3_100_000, j(lineOf(rentYear, "office_rent")));
  const sept = rowOf((await month(accountant, "month=2026-09")).body?.data ?? [], "rent_utilities");
  check("September alone: 10,000 budget, 1,000 spent", sept?.allocatedMinor === 1_000_000 && sept?.spentMinor === 100_000, j(sept));

  step("What is refused");
  const refused = async (label: string, body: Record<string, unknown>, want = 422) => {
    const r = await set(body);
    check(label, r.status === want, show(r));
  };
  await refused("VAT Control — not spending", { category: "vat_control", allocatedMinor: 100 });
  await refused("Employee Advances — not spending", { category: "employee_advances", allocatedMinor: 100 });
  await refused("Loan Principal — not spending", { category: "loan_financing", subcategory: "loan_principal", allocatedMinor: 100 });
  await refused("a category that isn't one", { category: "no_such_thing", allocatedMinor: 100 });
  await refused("a subcategory of another category", { category: "rent_utilities", subcategory: "meta_ads", allocatedMinor: 100 });
  await refused("a negative amount", { category: "rent_utilities", allocatedMinor: -1 });
  await refused("a month that isn't one", { category: "rent_utilities", period: "2026-13", allocatedMinor: 100 });
  check("…none of them saved", (await CategoryBudgetModel.countDocuments({ organizationId: org._id, category: { $in: ["vat_control", "employee_advances", "no_such_thing"] } })) === 0
    && (await CategoryBudgetModel.countDocuments({ organizationId: org._id, subcategory: { $in: ["loan_principal", "meta_ads"] }, category: { $ne: "advertising_marketing" } })) === 0);

  step("Who");
  const mgr = await month(manager);
  check("a manager (budget:read) sees it", mgr.status === 200 && (mgr.body?.data ?? []).length > 0, show(mgr));
  check("…but can't set it", (await set({ category: "bank_fees", allocatedMinor: 100 }, manager)).status === 403);
  check("…nor read the history of the budgets", (await request("GET", "/budgets/category-allocations?year=2026", undefined, manager)).status === 403);
  check("staff who see only their department's budget: not the company's spending", (await month(staff)).status === 403);
  check("…and can't set one", (await set({ category: "bank_fees", allocatedMinor: 100 }, staff)).status === 403);
  check("nobody signed in: 401", (await request("GET", `/budgets/categories?month=${OCT}`)).status === 401);

  step("The department allocations go on as before");
  const dept = await request("PATCH", "/budgets/allocations", { departmentId: String(marketing._id), period: OCT, currency: "AED", allocatedMinor: 100_000, note: "" }, accountant);
  const summary = await request("GET", `/budgets/summary?month=${OCT}&departmentId=${marketing._id}`, undefined, accountant);
  const mk = (summary.body?.data ?? []).find((r: any) => r.currency === "AED");
  check("Marketing's October: its own 1,000 allocation and its own 2,000 of expenses — no category budget in it", dept.status === 200 && mk?.allocatedMinor === 100_000 && mk?.approvedExpensesMinor === 200_000, j(mk));
  const after = rowOf((await month()).body?.data ?? [], "rent_utilities");
  check("…and the category view unchanged by it", after?.allocatedMinor === 4_000_000, j(after));

  console.log(`\n${failures ? `\x1b[31m${checks - failures}/${checks} checks passed — ${failures} FAILED\x1b[0m` : `\x1b[32m${checks}/${checks} checks passed\x1b[0m`}`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
