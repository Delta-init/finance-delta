/**
 * Categories on petty cash (the user, 2026-10-22: "in petty add category also show, and category and subcategory
 * filter") — addTransaction, updateTransaction and listTransactions against a scratch database.
 *
 * What it proves:
 *   - money paid out takes an expense category and subcategory, checked against the organization's list (an unknown
 *     one, or a category without its subcategory, is refused); money coming in takes none;
 *   - the cash book shows a line's own category, and on the line an expense paid from the tin made, the expense's;
 *   - the Category filter finds both kinds; Subcategory narrows it; "none" is money out with no category, never a
 *     transfer, money in or an expense's line;
 *   - an edit can change or clear it; a line turned into money coming in loses it.
 *
 * Run through scripts/petty-categories-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { BankAccount } = await import("../modules/banking/bank-account.model");
const { Expense } = await import("../modules/expense/expense.model");
const { User } = await import("../modules/user/user.model");
const bank = await import("../modules/banking/banking.service");
const { createTransfer } = await import("../modules/banking/transfer.service");
const { createExpense } = await import("../modules/expense/expense.service");
const { bankTransactionQuerySchema, createBankTransactionSchema, createExpenseSchema } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 600);
async function refused(p: Promise<unknown>, like: RegExp): Promise<string> {
  try { await p; return "not refused"; } catch (e) { const m = (e as Error).message; return like.test(m) ? "" : m; }
}

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const ORG = new Types.ObjectId();
const org = String(ORG);
const user = await User.collection.insertOne({ name: "Accountant", email: "acc@e2e.local", status: "active", memberships: [{ organizationId: ORG, status: "active" }] });
const account = async (name: string, type: string) => String((await BankAccount.collection.insertOne({
  organizationId: ORG, accountName: name, accountType: type, currency: "AED", currentBalanceMinor: 0, openingBalanceMinor: 100_000,
  openingDate: new Date("2026-01-01"), isActive: true, createdAt: new Date(), updatedAt: new Date(),
})).insertedId);
const TIN = await account("Delta Petty", "petty_cash"), BANK = await account("Delta Bank", "current");
const line = (over: Record<string, unknown>) => bank.addTransaction(org, TIN, createBankTransactionSchema.parse({ date: "2026-10-20", description: "x", ...over }));

/* ── 1 ── */
step("1. Entering");
const tea = await line({ description: "Tea and milk", amountMinor: -2_500, category: "office_supplies", subcategory: "pantry_supplies" });
check("money out takes a category and subcategory, with their names", tea.category?.slug === "office_supplies" && tea.category.subcategory === "pantry_supplies"
  && tea.category.name === "Office Supplies & Pantry" && tea.category.subcategoryName === "Pantry Supplies" && tea.category.fromExpense === false, j(tea.category));
const taxi = await line({ description: "Taxi", amountMinor: -3_000, category: "travel_transport", subcategory: "business_taxi" });
const pens = await line({ description: "Pens", amountMinor: -1_200, category: "office_supplies", subcategory: "stationery" });
const plain = await line({ description: "Something", amountMinor: -500 });
check("…and without one it has none", plain.category === undefined, j(plain.category));
const topUp = await line({ description: "Cash in", amountMinor: 50_000 });
let why = await refused(line({ description: "Cash in", amountMinor: 10_000, category: "office_supplies", subcategory: "stationery" }), /money paid out/);
check("money coming in is refused a category", !why, why);
why = await refused(line({ amountMinor: -100, category: "made_up" }), /Unknown expense category/);
check("an unknown category is refused", !why, why);
why = await refused(line({ amountMinor: -100, category: "office_supplies" }), /subcategory/i);
check("a category without its subcategory is refused", !why, why);
why = await refused(line({ amountMinor: -100, category: "office_supplies", subcategory: "fuel" }), /not a subcategory/);
check("a subcategory of another category is refused", !why, why);

// An expense paid from the tin: its line takes the expense's category, never one of its own.
const exp = await createExpense(org, String(user.insertedId), createExpenseSchema.parse({
  category: "travel_transport", subcategory: "fuel", description: "Fuel for the LC", expenseDate: "2026-10-20", amountMinor: 4_000,
  paymentMethod: "cash", bankAccountId: TIN, paidOn: "2026-10-20",
}));
const expLine = await Expense.findById(exp.id).select("bankTransactionId").lean<any>();
check("the expense put its line in the tin", !!expLine?.bankTransactionId);
await createTransfer(org, { fromAccountId: BANK, toAccountId: TIN, date: "2026-10-20", amountMinor: 20_000, reference: "", notes: "" } as never);

/* ── 2 ── */
step("2. The cash book");
const list = async (over: Record<string, unknown> = {}) =>
  (await bank.listTransactions(org, TIN, bankTransactionQuerySchema.parse({ page: 1, pageSize: 100, sort: "date", dir: "asc", ...over }) as never)).data;
const all = await list();
const fuel = all.find((r) => r.matches.some((m) => m.referenceNumber === exp.expenseNumber));
check("the expense's line shows the expense's category", fuel?.category?.slug === "travel_transport" && fuel.category.subcategory === "fuel" && fuel.category.fromExpense === true, j(fuel?.category));
check("a typed line shows its own", all.find((r) => r.id === tea.id)?.category?.name === "Office Supplies & Pantry");
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const named = async (label: string, over: Record<string, unknown>, want: string[]) => {
  const got = ids(await list(over));
  check(`${label}: ${want.length}`, j(got) === j([...want].sort()), j(got));
};
await named("Office Supplies & Pantry", { category: "office_supplies" }, [tea.id, pens.id]);
await named("…› Stationery", { category: "office_supplies", subcategory: "stationery" }, [pens.id]);
await named("Travel & Transportation — the typed taxi and the expense's fuel", { category: "travel_transport" }, [taxi.id, fuel!.id]);
await named("…› Fuel — only the expense's", { category: "travel_transport", subcategory: "fuel" }, [fuel!.id]);
await named("Uncategorised: money out with none — not money in, the transfer or the expense's line", { category: "none" }, [plain.id]);
await named("Search still narrows inside a category", { category: "office_supplies", q: "pens" }, [pens.id]);

/* ── 3 ── */
step("3. Correcting");
let edited = await bank.updateTransaction(org, TIN, plain.id, { category: "employee_reimbursements", subcategory: "staff_meals" });
check("an edit gives it a category", edited.category?.subcategoryName === "Staff Meals", j(edited.category));
await named("…and Uncategorised no longer finds it", { category: "none" }, []);
edited = await bank.updateTransaction(org, TIN, plain.id, { category: "" });
check("…and \"\" clears it", edited.category === undefined, j(edited.category));
edited = await bank.updateTransaction(org, TIN, tea.id, { description: "Tea, milk and sugar" });
check("an edit that leaves it out keeps it", edited.category?.subcategory === "pantry_supplies", j(edited.category));
edited = await bank.updateTransaction(org, TIN, tea.id, { amountMinor: 2_500 });
check("turned into money coming in, it loses it", edited.category === undefined, j(edited.category));
check("money in still has none in the list", (await list()).find((r) => r.id === topUp.id)?.category === undefined);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
