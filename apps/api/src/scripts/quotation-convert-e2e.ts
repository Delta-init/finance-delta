/**
 * Drives an accepted quotation through every way of turning it into an invoice,
 * over real HTTP against a real API process.
 *
 * It exists because none of this had ever executed. Converting a quotation
 * answered 500 in all four modes, for as long as the code had been there: a
 * `const` was read from inside a `.map()` fifteen lines before it was declared,
 * so the first thing the endpoint did was throw a ReferenceError. TypeScript
 * cannot see that — the read is in a closure, and it has no way to know the
 * closure runs immediately — and there was no test on the path at all. Only
 * calling it can find it.
 *
 * Four modes, because they build their lines differently and a fault in one
 * says nothing about the others:
 *
 *   full        the whole quote, its exact lines and prices
 *   amount      a fixed sum, as a single labelled portion line
 *   percentage  a share of the total, likewise
 *   per_line    a custom ex-tax figure against each line
 *
 * Run through scripts/quotation-convert-e2e.sh, which stands up a throwaway
 * mongod and a throwaway API and tears both down. This refuses to run against
 * anything that does not look like a scratch database.
 */
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Customer } from "../modules/customer/customer.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

const PORT = process.env.E2E_API_PORT ?? "4112";
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

async function main() {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();

  // ── Fixtures ──────────────────────────────────────────────────────────────
  step("Setting up an organization");
  const org = await Organization.create({
    name: "Delta HQ",
    baseCurrency: "INR",
    // GST, because that is the configuration where an HSN/SAC default exists
    // and therefore where the ordering fault was reachable at all.
    taxSystem: "gst",
    taxLabel: "GST",
    taxRates: [
      { label: "CGST 9%", code: "CGST", rate: 9, isDefault: true, appliesTo: "sales" },
      { label: "SGST 9%", code: "SGST", rate: 9, isDefault: true, appliesTo: "sales" },
    ],
    invoiceDefaults: { hsnSac: "9992", roundTotals: true },
  });
  const orgId = String(org._id);

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

  const admin = await User.create({
    name: "Org Admin",
    email: "admin@e2e-test.com",
    passwordHash: await hashPassword(PASSWORD),
    status: "active",
    memberships: [
      { organizationId: org._id, roleId: new Types.ObjectId(adminRoleId), status: "active" },
    ],
  });

  const customer = await Customer.create({
    organizationId: org._id,
    customerCode: "CUS-00001",
    name: "Quote Client",
    email: "client@e2e-test.com",
    phone: "+919000000000",
    currency: "INR",
    status: "active",
  });

  const login = await post("/auth/login", { email: "admin@e2e-test.com", password: PASSWORD });
  const token = (login.body?.data as unknown as { accessToken?: string } | undefined)?.accessToken;
  if (!token) throw new Error(`login failed: ${JSON.stringify(login.body).slice(0, 200)}`);

  const today = new Date().toISOString().slice(0, 10);

  /** A fresh accepted quotation, since each conversion consumes its balance. */
  async function acceptedQuote(totalMinor: number): Promise<{ id: string; total: number }> {
    const created = await post(
      "/quotations",
      {
        customerId: String(customer._id),
        salespersonId: String(admin._id),
        issueDate: today,
        expiryDate: today,
        currency: "INR",
        lineItems: [
          { description: "Consulting", quantity: 1, unitPriceMinor: Math.round(totalMinor / 2) },
          { description: "Support", quantity: 1, unitPriceMinor: Math.round(totalMinor / 2) },
        ],
      },
      token,
    );
    const q = created.body?.data as unknown as { id?: string; totalMinor?: number } | undefined;
    if (!q?.id) throw new Error(`quotation failed: ${JSON.stringify(created.body).slice(0, 300)}`);
    await post(`/quotations/${q.id}/send`, undefined, token);
    await post(`/quotations/${q.id}/accept`, undefined, token);
    return { id: q.id, total: q.totalMinor ?? 0 };
  }

  // ── The conversions ───────────────────────────────────────────────────────
  step("Converting an accepted quotation");

  {
    const q = await acceptedQuote(100_000_00);
    const r = await post(`/quotations/${q.id}/convert-invoice`, { mode: "full" }, token);
    const inv = (r.body?.data as unknown as { invoice?: { id: string; invoiceNumber: string } } | undefined)?.invoice;
    check("the whole quote converts", r.status === 200 && Boolean(inv?.id), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

    if (inv?.id) {
      const fetched = await get(`/invoices/${inv.id}`, token);
      const d = fetched.body?.data as unknown as { totalMinor?: number; lineItems?: { hsnSac?: string }[] } | undefined;
      check("...for the quote's own total", d?.totalMinor === q.total, `invoice=${d?.totalMinor} quote=${q.total}`);
      // The value whose declaration order caused the fault: if it arrives, the
      // line was built after the defaults were read, which is the whole fix.
      check("...carrying the organization's HSN/SAC", d?.lineItems?.[0]?.hsnSac === "9992", `got ${JSON.stringify(d?.lineItems?.[0]?.hsnSac)}`);
    }
  }

  {
    const q = await acceptedQuote(17_700_00);
    // 5,000 rupees of a 17,700 quote — minor units, as the field is defined.
    const r = await post(`/quotations/${q.id}/convert-invoice`, { mode: "amount", amountMinor: 500_000 }, token);
    const inv = (r.body?.data as unknown as { invoice?: { id: string } } | undefined)?.invoice;
    check("a fixed amount converts", r.status === 200 && Boolean(inv?.id), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

    if (inv?.id) {
      const fetched = await get(`/invoices/${inv.id}`, token);
      const total = (fetched.body?.data as unknown as { totalMinor?: number } | undefined)?.totalMinor ?? 0;
      // Rounded to whole rupees by the organization's own setting, so the
      // comparison allows the rounding rather than pinning the paise.
      check("...for the amount asked for", Math.abs(total - 500_000) <= 100, `invoice=${total} asked=500000`);
    }
  }

  {
    const q = await acceptedQuote(20_000_00);
    const r = await post(`/quotations/${q.id}/convert-invoice`, { mode: "percentage", percentage: 25 }, token);
    const inv = (r.body?.data as unknown as { invoice?: { id: string } } | undefined)?.invoice;
    check("a percentage converts", r.status === 200 && Boolean(inv?.id), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

    if (inv?.id) {
      const fetched = await get(`/invoices/${inv.id}`, token);
      const total = (fetched.body?.data as unknown as { totalMinor?: number } | undefined)?.totalMinor ?? 0;
      check("...for a quarter of the quote", Math.abs(total - q.total / 4) <= 100, `invoice=${total} quarter=${q.total / 4}`);
    }
  }

  {
    const q = await acceptedQuote(30_000_00);
    const r = await post(
      `/quotations/${q.id}/convert-invoice`,
      { mode: "per_line", lineAmountsMinor: [200_000, 0] },
      token,
    );
    const inv = (r.body?.data as unknown as { invoice?: { id: string } } | undefined)?.invoice;
    check("a per-line amount converts", r.status === 200 && Boolean(inv?.id), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

    if (inv?.id) {
      const fetched = await get(`/invoices/${inv.id}`, token);
      const lines = (fetched.body?.data as unknown as { lineItems?: unknown[] } | undefined)?.lineItems ?? [];
      check("...with the zeroed line left off", lines.length === 1, `${lines.length} line(s)`);
    }
  }

  // ── The guards, which must still refuse ───────────────────────────────────
  step("Refusing what it should refuse");
  {
    const q = await acceptedQuote(10_000_00);
    const tooMuch = await post(
      `/quotations/${q.id}/convert-invoice`,
      { mode: "amount", amountMinor: 99_999_00 },
      token,
    );
    check("more than the balance is refused", tooMuch.status === 409, `got ${tooMuch.status}`);

    const zero = await post(`/quotations/${q.id}/convert-invoice`, { mode: "amount", amountMinor: 0 }, token);
    // 422: the service raises VALIDATION_ERROR, which is what that maps to.
    check("an amount of nothing is refused", zero.status === 422, `got ${zero.status}`);

    // Twice over: the balance falls after the first, so the second must fail.
    await post(`/quotations/${q.id}/convert-invoice`, { mode: "full" }, token);
    const again = await post(`/quotations/${q.id}/convert-invoice`, { mode: "full" }, token);
    check("a fully invoiced quote cannot be invoiced again", again.status === 409, `got ${again.status}`);
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
