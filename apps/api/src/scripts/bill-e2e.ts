/**
 * Drives deleting and editing a bill over real HTTP against a real API process.
 *
 * Deleting is not voiding. Voiding leaves a marked row in the payables book,
 * which is right for a bill that was real and then wasn't. Deleting is for the
 * ones that were never real — a draft typed twice, a test entry — and it takes
 * the row away entirely. That makes the guards the whole point of the feature:
 * what must not be deletable matters more than what must.
 *
 * So most of this is the refusals. A bill that is approved or paid stays. A
 * voided bill with a payment against it stays, because the payment happened and
 * would otherwise be stranded. A bill a purchase order was converted into
 * stays, because the PO is marked billed and would be left pointing at nothing.
 * A vendor credit raised against a bill pins it likewise.
 *
 * Run through scripts/bill-delete-e2e.sh, which stands up a throwaway mongod
 * and a throwaway API and tears both down. This refuses to run against anything
 * that does not look like a scratch database.
 */
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Vendor } from "../modules/vendor/vendor.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

const PORT = process.env.E2E_API_PORT ?? "4113";
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

  const vendor = await Vendor.create({
    organizationId: org._id,
    vendorCode: "VEN-00001",
    name: "Gulf Supplies",
    email: "accounts@e2e-test.com",
    phone: "+971400000000",
    currency: "AED",
    status: "active",
  });

  const login = await post("/auth/login", { email: "admin@e2e-test.com", password: PASSWORD });
  const token = (login.body?.data as unknown as { accessToken?: string } | undefined)?.accessToken;
  if (!token) throw new Error(`login failed: ${JSON.stringify(login.body).slice(0, 200)}`);

  const today = new Date().toISOString().slice(0, 10);

  /** A fresh draft bill, since each case consumes the one it acts on. */
  async function draftBill(totalMinor = 100_000): Promise<string> {
    const created = await post(
      "/bills",
      {
        vendorId: String(vendor._id),
        billDate: today,
        dueDate: today,
        currency: "AED",
        lineItems: [
          { description: "Stationery", quantity: 1, unitPriceMinor: totalMinor, discountPct: 0, taxPct: 0 },
        ],
      },
      token,
    );
    const b = created.body?.data as unknown as { id?: string } | undefined;
    if (!b?.id) throw new Error(`bill failed: ${JSON.stringify(created.body).slice(0, 300)}`);
    return b.id;
  }

  const exists = async (id: string) => (await get(`/bills/${id}`, token)).status === 200;

  // ── What should go ────────────────────────────────────────────────────────
  step("Deleting what can be deleted");
  {
    // A freshly created bill is `approved`, not `draft` — nothing ever writes
    // `draft` — so this is the ordinary "entered by mistake" case the feature
    // exists for, and the one a status-based rule would have refused.
    const id = await draftBill();
    const fetched = await get(`/bills/${id}`, token);
    const status = (fetched.body?.data as unknown as { status?: string } | undefined)?.status;
    check("a new bill opens as approved", status === "approved", `status was ${status}`);

    const r = await del(`/bills/${id}`, token);
    check("an unpaid bill is deleted", r.status === 204, `got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    check("...and is really gone", !(await exists(id)));
  }
  {
    const id = await draftBill();
    await post(`/bills/${id}/void`, undefined, token);
    const r = await del(`/bills/${id}`, token);
    check("a voided bill with no payments is deleted", r.status === 204, `got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    check("...and is really gone", !(await exists(id)));
  }

  // ── What must stay ────────────────────────────────────────────────────────
  step("Refusing what must stay");
  {
    // Approval is not what protects a bill; a payment is. An approved bill with
    // nothing paid is still just an entry somebody may have made in error.
    const id = await draftBill();
    await post(`/bills/${id}/approve`, undefined, token);
    const r = await del(`/bills/${id}`, token);
    check("an approved but unpaid bill is still deletable", r.status === 204, `got ${r.status}`);
  }
  {
    const id = await draftBill();
    await post(`/bills/${id}/approve`, undefined, token);
    await post(
      `/bills/${id}/payments`,
      { method: "bank_transfer", amountMinor: 100_000, paidOn: today },
      token,
    );
    const r = await del(`/bills/${id}`, token);
    check("a paid bill is refused", r.status === 409, `got ${r.status}`);
    check("...and survives", await exists(id));
  }
  {
    // Paid, then voided: voiding a paid bill is itself refused, so this reaches
    // the payment guard through a partial payment instead.
    const id = await draftBill(100_000);
    await post(`/bills/${id}/approve`, undefined, token);
    await post(
      `/bills/${id}/payments`,
      { method: "cash", amountMinor: 40_000, paidOn: today },
      token,
    );
    const voided = await post(`/bills/${id}/void`, undefined, token);
    check("a part-paid bill can still be voided", voided.status === 200, `got ${voided.status}`);
    const r = await del(`/bills/${id}`, token);
    check("a voided bill carrying a payment is refused", r.status === 409, `got ${r.status}`);
    check("...and survives", await exists(id));
    const msg = String((r.body as unknown as { error?: { message?: string } })?.error?.message ?? "");
    check("...saying why", /payment/i.test(msg), `message was "${msg}"`);
  }

  // ── What something else points at ─────────────────────────────────────────
  step("Refusing a bill something else depends on");
  {
    const po = await post(
      "/purchase-orders",
      {
        vendorId: String(vendor._id),
        issueDate: today,
        currency: "AED",
        lineItems: [
          { description: "Chairs", quantity: 2, unitPriceMinor: 50_000, discountPct: 0, taxPct: 0 },
        ],
      },
      token,
    );
    const poId = (po.body?.data as unknown as { id?: string } | undefined)?.id;
    check("a purchase order is raised", Boolean(poId), JSON.stringify(po.body).slice(0, 200));

    if (poId) {
      await post(`/purchase-orders/${poId}/send`, undefined, token);
      await post(`/purchase-orders/${poId}/receive`, undefined, token);
      const conv = await post(`/purchase-orders/${poId}/convert-to-bill`, undefined, token);
      const billId = (conv.body?.data as unknown as { billId?: string } | undefined)?.billId;
      check("...and converts into a bill", Boolean(billId), `${conv.status} ${JSON.stringify(conv.body).slice(0, 200)}`);

      if (billId) {
        const r = await del(`/bills/${billId}`, token);
        check("the bill it became cannot be deleted", r.status === 409, `got ${r.status}`);
        check("...and survives", await exists(billId));
        const msg = String((r.body as unknown as { error?: { message?: string } })?.error?.message ?? "");
        check("...naming the purchase order", /purchase order/i.test(msg), `message was "${msg}"`);
      }
    }
  }
  {
    const id = await draftBill(80_000);
    const vc = await post(
      "/vendor-credits",
      {
        vendorId: String(vendor._id),
        sourceBillId: id,
        reason: "Returned goods",
        issueDate: today,
        currency: "AED",
        lineItems: [
          { description: "Returned goods", quantity: 1, unitPriceMinor: 20_000, discountPct: 0, taxPct: 0 },
        ],
      },
      token,
    );
    check("a vendor credit is raised against a bill", vc.status === 201 || vc.status === 200, `${vc.status} ${JSON.stringify(vc.body).slice(0, 200)}`);

    const r = await del(`/bills/${id}`, token);
    check("the credited bill cannot be deleted", r.status === 409, `got ${r.status}`);
    check("...and survives", await exists(id));
  }

  // ── Editing a bill money has moved against ────────────────────────────────
  step("Editing a bill with payments against it");

  /** A bill with `paid` already paid, of `totalMinor`. */
  async function partPaid(totalMinor: number, paid: number): Promise<string> {
    const id = await draftBill(totalMinor);
    await post(`/bills/${id}/approve`, undefined, token);
    await post(`/bills/${id}/payments`, { method: "cash", amountMinor: paid, paidOn: today }, token);
    return id;
  }

  const lines = (unitPriceMinor: number) => ({
    lineItems: [{ description: "Stationery", quantity: 1, unitPriceMinor, discountPct: 0, taxPct: 0 }],
  });

  {
    // The case the guard used to refuse outright.
    const id = await partPaid(100_000, 40_000);
    const r = await patch(`/bills/${id}`, lines(150_000), token);
    check("a part-paid bill can be edited", r.status === 200, `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

    const d = (await get(`/bills/${id}`, token)).body?.data as unknown as
      { totalMinor?: number; amountPaidMinor?: number; balanceMinor?: number; status?: string } | undefined;
    check("...the new total sticks", d?.totalMinor === 150_000, `total=${d?.totalMinor}`);
    check("...the payment is untouched", d?.amountPaidMinor === 40_000, `paid=${d?.amountPaidMinor}`);
    check("...the balance follows the total", d?.balanceMinor === 110_000, `balance=${d?.balanceMinor}`);
    check("...and it is still partially paid", d?.status === "partially_paid", `status=${d?.status}`);
  }
  {
    // Edited down to exactly what was paid: nothing is outstanding any more, so
    // the bill is settled and must say so.
    const id = await partPaid(100_000, 40_000);
    const r = await patch(`/bills/${id}`, lines(40_000), token);
    check("a part-paid bill edited down to what was paid saves", r.status === 200, `got ${r.status}`);

    const d = (await get(`/bills/${id}`, token)).body?.data as unknown as
      { balanceMinor?: number; status?: string } | undefined;
    check("...leaves nothing outstanding", d?.balanceMinor === 0, `balance=${d?.balanceMinor}`);
    check("...and becomes paid", d?.status === "paid", `status=${d?.status}`);
  }
  {
    // A settled bill edited upwards is owed again.
    const id = await partPaid(100_000, 100_000);
    const before = (await get(`/bills/${id}`, token)).body?.data as unknown as { status?: string } | undefined;
    check("a fully paid bill starts out paid", before?.status === "paid", `status=${before?.status}`);

    const r = await patch(`/bills/${id}`, lines(180_000), token);
    check("...can be edited upwards", r.status === 200, `got ${r.status}`);

    const d = (await get(`/bills/${id}`, token)).body?.data as unknown as
      { balanceMinor?: number; status?: string } | undefined;
    check("...is owed the difference", d?.balanceMinor === 80_000, `balance=${d?.balanceMinor}`);
    check("...and is partially paid again", d?.status === "partially_paid", `status=${d?.status}`);
  }
  {
    // The floor: a bill cannot be worth less than what has gone out of the door.
    const id = await partPaid(100_000, 60_000);
    const r = await patch(`/bills/${id}`, lines(20_000), token);
    check("below what is already paid is refused", r.status === 409, `got ${r.status}`);
    const msg = String((r.body as unknown as { error?: { message?: string } })?.error?.message ?? "");
    check("...saying so in money", /600\.00|vendor credit/i.test(msg), `message was "${msg}"`);

    const d = (await get(`/bills/${id}`, token)).body?.data as unknown as
      { totalMinor?: number; balanceMinor?: number } | undefined;
    check("...and changes nothing", d?.totalMinor === 100_000 && d?.balanceMinor === 40_000, `total=${d?.totalMinor} balance=${d?.balanceMinor}`);
  }
  {
    const id = await draftBill();
    await post(`/bills/${id}/void`, undefined, token);
    const r = await patch(`/bills/${id}`, lines(50_000), token);
    check("a voided bill still cannot be edited", r.status === 409, `got ${r.status}`);
  }

  // ── Nonsense ──────────────────────────────────────────────────────────────
  step("Refusing nonsense");
  {
    const missing = await del(`/bills/${new Types.ObjectId()}`, token);
    check("an unknown bill is a 404", missing.status === 404, `got ${missing.status}`);

    const id = await draftBill();
    const anon = await del(`/bills/${id}`);
    check("deleting without a token is refused", anon.status === 401, `got ${anon.status}`);
    check("...and the bill survives", await exists(id));
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
