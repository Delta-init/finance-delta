/**
 * Drives correcting an invoice that has already gone out, and bringing one
 * back from void.
 *
 * Neither was possible. An invoice could only be edited while it was a draft,
 * so a wrong invoice already in a client's hands — the case that most needs
 * fixing — could only be voided and retyped, losing its number, its enrolment
 * and any payment recorded against it. And voiding was final: the invoice was
 * spent, and somebody who voided the wrong one raised a new one and explained
 * the gap.
 *
 * What replaces the old refusal is a floor and a recount. An invoice cannot be
 * edited below what has already been received — the balance would go negative,
 * which an invoice cannot express — and its status follows the new total, so
 * one edited down to what was paid is settled and one edited up is owed again.
 *
 * Run through scripts/invoice-e2e.sh, which stands up a throwaway mongod and a
 * throwaway API. Scratch database only.
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

const PORT = process.env.E2E_API_PORT ?? "4116";
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
const patch = (p: string, b?: unknown, t?: string) => request("PATCH", p, b, t);
const get = (p: string, t?: string) => request("GET", p, undefined, t);
const del = (p: string, t?: string) => request("DELETE", p, undefined, t);

async function main() {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();

  step("Setting up an organization");
  const org = await Organization.create({ name: "Delta HQ", baseCurrency: "AED" });
  for (const def of SYSTEM_ROLES) {
    await Role.create({
      organizationId: org._id, key: def.key, name: def.name,
      description: def.description, permissions: def.permissions, isSystem: true,
    });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const adminRoleId = String(roles.find((r) => r.key === "admin")!._id);
  const admin = await User.create({
    name: "Org Admin", email: "admin@e2e-test.com",
    passwordHash: await hashPassword(PASSWORD), status: "active",
    memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(adminRoleId), status: "active" }],
  });
  const customer = await Customer.create({
    organizationId: org._id, customerCode: "CUS-00001", name: "Client One",
    email: "client@e2e-test.com", phone: "+971500000000", currency: "AED", status: "active",
  });

  const login = await post("/auth/login", { email: "admin@e2e-test.com", password: PASSWORD });
  const token = (login.body?.data as unknown as { accessToken?: string } | undefined)?.accessToken;
  if (!token) throw new Error(`login failed: ${JSON.stringify(login.body).slice(0, 200)}`);

  const today = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  const lines = (unitPriceMinor: number) => ({
    lineItems: [{ description: "Consulting", quantity: 1, unitPriceMinor }],
  });

  async function draft(totalMinor: number): Promise<string> {
    const r = await post("/invoices", {
      customerId: String(customer._id), salespersonId: String(admin._id),
      issueDate: today, dueDate: future, currency: "AED", ...lines(totalMinor),
    }, token);
    const inv = r.body?.data as unknown as { id?: string } | undefined;
    if (!inv?.id) throw new Error(`invoice failed: ${JSON.stringify(r.body).slice(0, 300)}`);
    return inv.id;
  }
  const read = async (id: string) =>
    (await get(`/invoices/${id}`, token)).body?.data as unknown as
      { status?: string; totalMinor?: number; amountPaidMinor?: number; balanceMinor?: number };
  async function sent(totalMinor: number): Promise<string> {
    const id = await draft(totalMinor);
    await post(`/invoices/${id}/send`, undefined, token);
    return id;
  }

  // ── Correcting one that has gone out ──────────────────────────────────────
  step("Correcting an invoice that has already been sent");
  {
    const id = await sent(100_000);
    const before = await read(id);
    check("it starts out sent", before?.status === "sent", `status=${before?.status}`);

    const r = await patch(`/invoices/${id}`, lines(150_000), token);
    check("a sent invoice can be edited", r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

    const after = await read(id);
    check("...the new total sticks", after?.totalMinor === 150_000, `total=${after?.totalMinor}`);
    check("...and the balance follows it", after?.balanceMinor === 150_000, `balance=${after?.balanceMinor}`);
    check("...while it stays sent", after?.status === "sent", `status=${after?.status}`);
  }
  {
    const id = await sent(100_000);
    await post(`/invoices/${id}/payments`, { method: "cash", amountMinor: 40_000, paidOn: today }, token);

    const r = await patch(`/invoices/${id}`, lines(200_000), token);
    check("a part-paid invoice can be edited", r.status === 200, `got ${r.status}`);
    const d = await read(id);
    check("...the payment is untouched", d?.amountPaidMinor === 40_000, `paid=${d?.amountPaidMinor}`);
    check("...the balance is the difference", d?.balanceMinor === 160_000, `balance=${d?.balanceMinor}`);
    check("...and it is still partly paid", d?.status === "partial", `status=${d?.status}`);
  }
  {
    // Edited down to exactly what was received: nothing is outstanding, so it
    // is settled and has to say so.
    const id = await sent(100_000);
    await post(`/invoices/${id}/payments`, { method: "cash", amountMinor: 40_000, paidOn: today }, token);
    const r = await patch(`/invoices/${id}`, lines(40_000), token);
    check("edited down to what was received, it saves", r.status === 200, `got ${r.status}`);
    const d = await read(id);
    check("...leaving nothing outstanding", d?.balanceMinor === 0, `balance=${d?.balanceMinor}`);
    check("...and reading as paid", d?.status === "paid", `status=${d?.status}`);
  }
  {
    // The floor.
    const id = await sent(100_000);
    await post(`/invoices/${id}/payments`, { method: "cash", amountMinor: 60_000, paidOn: today }, token);
    const r = await patch(`/invoices/${id}`, lines(20_000), token);
    check("below what was received is refused", r.status === 409, `got ${r.status}`);
    const msg = String((r.body as unknown as { error?: { message?: string } })?.error?.message ?? "");
    check("...pointing at a credit note", /credit note/i.test(msg), `"${msg}"`);
    const d = await read(id);
    check("...and nothing changed", d?.totalMinor === 100_000 && d?.balanceMinor === 40_000, `total=${d?.totalMinor} balance=${d?.balanceMinor}`);
  }

  // ── Out of void ───────────────────────────────────────────────────────────
  step("Bringing a voided invoice back");
  {
    const id = await sent(100_000);
    await post(`/invoices/${id}/void`, undefined, token);
    const voided = await read(id);
    check("it is voided", voided?.status === "void", `status=${voided?.status}`);

    const edit = await patch(`/invoices/${id}`, lines(50_000), token);
    check("a voided invoice still cannot be edited", edit.status === 409, `got ${edit.status}`);
    const msg = String((edit.body as unknown as { error?: { message?: string } })?.error?.message ?? "");
    check("...telling you to restore it first", /restore/i.test(msg), `"${msg}"`);

    const r = await post(`/invoices/${id}/restore`, undefined, token);
    check("it can be restored", r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const back = await read(id);
    check("...as a draft, since nothing was paid", back?.status === "draft", `status=${back?.status}`);

    const edit2 = await patch(`/invoices/${id}`, lines(70_000), token);
    check("...which can then be corrected", edit2.status === 200, `got ${edit2.status}`);

    const resend = await post(`/invoices/${id}/send`, undefined, token);
    check("...and sent again", resend.status === 200, `got ${resend.status}`);
    const final = await read(id);
    check("...arriving back at sent, for the corrected amount", final?.status === "sent" && final?.totalMinor === 70_000,
      `status=${final?.status} total=${final?.totalMinor}`);
  }
  {
    // A draft that has taken money is not a draft. One with payments comes
    // back to what its payments make it.
    const id = await sent(100_000);
    await post(`/invoices/${id}/payments`, { method: "cash", amountMinor: 40_000, paidOn: today }, token);
    await post(`/invoices/${id}/void`, undefined, token);
    await post(`/invoices/${id}/restore`, undefined, token);
    const d = await read(id);
    check("one with a payment does not come back as a draft", d?.status !== "draft", `status=${d?.status}`);
    check("...but as what its payments make it", d?.status === "partial", `status=${d?.status}`);
    check("...with the balance intact", d?.balanceMinor === 60_000, `balance=${d?.balanceMinor}`);
  }
  {
    const id = await sent(100_000);
    const r = await post(`/invoices/${id}/restore`, undefined, token);
    check("restoring one that was never voided is refused", r.status === 409, `got ${r.status}`);
  }

  await mongoose.disconnect();
  console.log("");
  if (failures) { console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`); process.exit(1); }
  console.log(`\x1b[32mAll ${checks} checks passed\x1b[0m`);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
