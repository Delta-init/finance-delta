/**
 * Drives an expense's payment status over real HTTP against a real API process.
 *
 * An expense had one status, and it was an approval workflow: drafted,
 * submitted, approved, rejected. Whether the money had actually left was
 * nowhere — an approved claim from March and one settled yesterday read
 * identically — so this is about the second question, which is new.
 *
 * The status is derived rather than stored, because "overdue" is a fact about
 * today and a stored copy would be wrong by the next morning. That is the thing
 * worth testing: the same unchanged document has to read `unpaid` before its
 * due date and `overdue` after it, without anything having written to it.
 *
 * The list filter is checked against the badge on every case, because two
 * implementations of one rule — a derivation in TypeScript and a query in Mongo
 * — is exactly where they drift apart.
 *
 * Run through scripts/expense-payment-e2e.sh, which stands up a throwaway
 * mongod and a throwaway API and tears both down. This refuses to run against
 * anything that does not look like a scratch database.
 */
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

const PORT = process.env.E2E_API_PORT ?? "4114";
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = "E2ePassword1!";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = "") {
  checks++;
  if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else {
    failures++;
    console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  }
}

function step(name: string) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

type Res = { status: number; body: Record<string, never> };

async function request(method: string, p: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, never> };
}

const post = (p: string, b?: unknown, t?: string) => request("POST", p, b, t);
const get = (p: string, t?: string) => request("GET", p, undefined, t);

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function main() {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();

  step("Setting up an organization");
  const org = await Organization.create({ name: "Delta HQ", baseCurrency: "AED" });
  for (const def of SYSTEM_ROLES) {
    await Role.create({
      organizationId: org._id,
      key: def.key,
      name: def.name,
      description: def.description,
      permissions: def.permissions,
      isSystem: true,
    });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const adminRoleId = String(roles.find((r) => r.key === "admin")!._id);
  await User.create({
    name: "Org Admin",
    email: "admin@e2e-test.com",
    passwordHash: await hashPassword(PASSWORD),
    status: "active",
    memberships: [
      { organizationId: org._id, roleId: new Types.ObjectId(adminRoleId), status: "active" },
    ],
  });

  const login = await post("/auth/login", { email: "admin@e2e-test.com", password: PASSWORD });
  const token = (login.body?.data as unknown as { accessToken?: string } | undefined)?.accessToken;
  if (!token) throw new Error(`login failed: ${JSON.stringify(login.body).slice(0, 200)}`);

  type Exp = { id: string; paymentStatus?: string; paidOn?: string; dueDate?: string };

  async function makeExpense(dueDate?: string): Promise<Exp> {
    const r = await post(
      "/expenses",
      {
        category: "travel",
        description: "Taxi to the airport",
        expenseDate: day(-3),
        amountMinor: 20_000,
        currency: "AED",
        ...(dueDate ? { dueDate } : {}),
      },
      token,
    );
    const e = r.body?.data as unknown as Exp | undefined;
    if (!e?.id) throw new Error(`create failed: ${JSON.stringify(r.body).slice(0, 300)}`);
    return e;
  }

  const read = async (id: string): Promise<Exp> =>
    (await get(`/expenses/${id}`, token)).body?.data as unknown as Exp;

  /** Whether the list filter for a status returns this expense. */
  async function listedUnder(status: string, id: string): Promise<boolean> {
    const r = await get(`/expenses?paymentStatus=${status}&pageSize=100`, token);
    const rows = (r.body?.data as unknown as Exp[]) ?? [];
    return rows.some((e) => e.id === id);
  }

  // ── The three states ──────────────────────────────────────────────────────
  step("Reading the status off the dates");
  {
    const e = await makeExpense();
    check("a new expense is unpaid", e.paymentStatus === "unpaid", `got ${e.paymentStatus}`);
    check("...and has no due date", !e.dueDate, `got ${e.dueDate}`);
    check("...and is listed under unpaid", await listedUnder("unpaid", e.id));
    check("...and not under overdue", !(await listedUnder("overdue", e.id)));
  }
  {
    const e = await makeExpense(day(7));
    check("one due next week is unpaid", e.paymentStatus === "unpaid", `got ${e.paymentStatus}`);
    check("...and is listed under unpaid", await listedUnder("unpaid", e.id));
    check("...and not under overdue", !(await listedUnder("overdue", e.id)));
  }
  {
    const e = await makeExpense(day(-1));
    check("one due yesterday is overdue", e.paymentStatus === "overdue", `got ${e.paymentStatus}`);
    check("...and is listed under overdue", await listedUnder("overdue", e.id));
    // The three are exclusive, which is what makes the filter match the badge.
    check("...and not under unpaid", !(await listedUnder("unpaid", e.id)));
  }
  {
    // The boundary. Due today is not yet late — compared by day, not by instant,
    // or everything falls overdue at one minute past midnight.
    const e = await makeExpense(day(0));
    check("one due today is not yet overdue", e.paymentStatus === "unpaid", `got ${e.paymentStatus}`);
  }

  // ── Settling ──────────────────────────────────────────────────────────────
  step("Settling and un-settling");
  {
    const e = await makeExpense(day(-5));
    check("it starts overdue", e.paymentStatus === "overdue", `got ${e.paymentStatus}`);

    const paid = await post(`/expenses/${e.id}/mark-paid`, { paidOn: day(-1) }, token);
    check("marking it paid works", paid.status === 200, `${paid.status} ${JSON.stringify(paid.body).slice(0, 200)}`);

    const after = await read(e.id);
    check("...it reads paid", after.paymentStatus === "paid", `got ${after.paymentStatus}`);
    check("...keeping the date it was paid", after.paidOn === day(-1), `got ${after.paidOn}`);
    // Paid beats overdue: a late claim that has been settled is settled.
    check("...and stops being overdue", !(await listedUnder("overdue", e.id)));
    check("...and is listed under paid", await listedUnder("paid", e.id));

    const undo = await post(`/expenses/${e.id}/mark-unpaid`, undefined, token);
    check("marking it unpaid again works", undo.status === 200, `got ${undo.status}`);
    const back = await read(e.id);
    check("...it returns to overdue", back.paymentStatus === "overdue", `got ${back.paymentStatus}`);
    check("...with the paid date gone", !back.paidOn, `got ${back.paidOn}`);
  }
  {
    // Method and reference are optional, and passing nothing must not blank
    // what the expense already carried.
    const r = await post(
      "/expenses",
      {
        category: "travel",
        description: "Hotel",
        expenseDate: day(-2),
        amountMinor: 50_000,
        currency: "AED",
        paymentMethod: "card",
        reference: "INV-991",
      },
      token,
    );
    const e = r.body?.data as unknown as Exp;
    await post(`/expenses/${e.id}/mark-paid`, { paidOn: day(0) }, token);
    const after = (await get(`/expenses/${e.id}`, token)).body?.data as unknown as
      { paymentMethod?: string; reference?: string };
    check("marking paid leaves the method alone", after?.paymentMethod === "card", `got ${after?.paymentMethod}`);
    check("...and the reference alone", after?.reference === "INV-991", `got ${after?.reference}`);
  }

  // ── Refusals ──────────────────────────────────────────────────────────────
  step("Refusing what cannot be settled");
  {
    const e = await makeExpense();
    await post(`/expenses/${e.id}/void`, undefined, token);
    const r = await post(`/expenses/${e.id}/mark-paid`, { paidOn: day(0) }, token);
    check("a voided expense cannot be marked paid", r.status === 409, `got ${r.status}`);
  }
  {
    // requiresApproval, because without it an expense opens at `approved` and
    // never passes through `submitted` — so submit and reject would both be
    // refused and this would pass for the wrong reason.
    const created = await post(
      "/expenses",
      {
        category: "travel",
        description: "Minibar",
        expenseDate: day(-2),
        amountMinor: 9_000,
        currency: "AED",
        requiresApproval: true,
      },
      token,
    );
    const e = created.body?.data as unknown as Exp & { status?: string };
    check("a claim needing approval opens as submitted", e.status === "submitted", `got ${e.status}`);

    const rejected = await post(`/expenses/${e.id}/reject`, { reason: "Not allowable" }, token);
    check("...and can be rejected", rejected.status === 200, `${rejected.status} ${JSON.stringify(rejected.body).slice(0, 160)}`);

    const r = await post(`/expenses/${e.id}/mark-paid`, { paidOn: day(0) }, token);
    check("a rejected expense cannot be marked paid", r.status === 409, `got ${r.status}`);
  }
  {
    const e = await makeExpense();
    const r = await post(`/expenses/${e.id}/mark-unpaid`, undefined, token);
    check("un-paying one that was never paid is refused", r.status === 409, `got ${r.status}`);
  }
  {
    const e = await makeExpense();
    const r = await post(`/expenses/${e.id}/mark-paid`, {}, token);
    check("marking paid without a date is refused", r.status === 422, `got ${r.status}`);
  }

  await mongoose.disconnect();

  console.log("");
  if (failures) {
    console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[32mAll ${checks} checks passed\x1b[0m`);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
