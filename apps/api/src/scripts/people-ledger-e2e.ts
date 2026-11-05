/**
 * The salesperson page's Ledger tab and the CRM salesperson backfill (the user, 2026-11-05), against a scratch database.
 *
 * Ledger (people-report.service personLedger): one person's invoices raised, payroll months (commission inside them),
 * expenses, and salary advances / one-time payments found by their employee code — newest first; void, rejected, bill
 * and somebody else's left out; a payroll month not paid yet listed and not counted; totals per currency; the kind,
 * the dates, the search, the order and the page all applied by the server; a login with no payroll record gets their
 * invoices and expenses only.
 *
 * Backfill (scripts/crm-salesperson-backfill.ts): invoices flagged "… has no account here" go to the CRM's
 * salesperson — an account made, one from another organization joining, or theirs here — and lose the flag; one with
 * no email is left; the dry run writes nothing; --expect guards; the undo puts it all back.
 *
 * Run through scripts/people-ledger-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { personLedger } = await import("../modules/payroll/people-report.service");
const { backfillCrmSalespeople, undoCrmSalespeople } = await import("./crm-salesperson-backfill");
const { ensureCrmSalesperson } = await import("../modules/user/crm-salesperson");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => String(JSON.stringify(v)).slice(0, 700);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

const ORG = new Types.ObjectId(), ROLE = new Types.ObjectId();
const REP = new Types.ObjectId(), OTHER = new Types.ObjectId(), EMP = new Types.ObjectId();
await db.collection("organizations").insertOne({ _id: ORG, name: "Delta HQ", baseCurrency: "AED" });
await db.collection("roles").insertOne({ _id: ROLE, organizationId: ORG, key: "admin", name: "Admin", permissions: ["*"] });
await db.collection("users").insertMany([
  { _id: REP, name: "Rep One", email: "rep@e2e.test", passwordHash: "x", status: "active", memberships: [{ organizationId: ORG, roleId: ROLE, status: "active" }] },
  { _id: OTHER, name: "Somebody Else", email: "else@e2e.test", passwordHash: "x", status: "active", memberships: [{ organizationId: ORG, roleId: ROLE, status: "active" }] },
] as any[]);
await db.collection("employees").insertOne({ _id: EMP, organizationId: ORG, userId: REP, employeeCode: "E0212", name: "Rep One", email: "rep@e2e.test", status: "active" } as any);

const inv = (n: string, o: Record<string, any>) => ({
  _id: new Types.ObjectId(), organizationId: ORG, invoiceNumber: n, customerId: new Types.ObjectId(), customerName: `Customer ${n}`,
  salespersonId: REP, salespersonName: "Rep One", currency: "AED", status: "paid", totalMinor: 100_00, amountPaidMinor: 100_00, balanceMinor: 0,
  issueDate: new Date("2026-10-01"), dueDate: new Date("2026-10-01"), enrolment: { course: "Forex" }, ...o,
});
const IN1 = inv("IN-00001", { issueDate: new Date("2026-10-05"), totalMinor: 225_000, amountPaidMinor: 225_000 });
const IN2 = inv("IN-00002", { issueDate: new Date("2026-11-02"), totalMinor: 100_000, amountPaidMinor: 40_000, balanceMinor: 60_000, status: "partial", customerName: "Zara Q" });
const IN5 = inv("IN-00005", { issueDate: new Date("2026-09-15"), currency: "INR", totalMinor: 6_000_000, amountPaidMinor: 6_000_000 });
await db.collection("invoices").insertMany([
  IN1, IN2, IN5,
  inv("IN-00003", { status: "void", issueDate: new Date("2026-10-06") }),
  inv("IN-00004", { salespersonId: OTHER, issueDate: new Date("2026-10-07") }),
] as any[]);

const L1 = new Types.ObjectId(), L2 = new Types.ObjectId();
const line = (_id: Types.ObjectId, o: Record<string, any>) => ({
  _id, employeeId: EMP, hrmsEmployeeId: "h1", name: "Rep One", employeeCode: "E0212", currency: "AED",
  grossMinor: 500_000, deductionsMinor: 20_000, adjustmentsMinor: 0, payableMinor: 480_000, amountPaidMinor: 0, status: "pending", holdReason: "", ...o,
});
await db.collection("payrollruns").insertMany([
  {
    _id: new Types.ObjectId(), organizationId: ORG, runNumber: "PAY-202610-001", period: "2026-10", status: "partially_paid", currency: "AED",
    lines: [line(L1, { adjustmentsMinor: 30_000, payableMinor: 510_000, amountPaidMinor: 510_000, status: "paid" })],
    adjustments: [{ externalId: "x:1", lineId: L1, kind: "addition", source: "crm_commission", label: "CRM commission", amountMinor: 30_000, recoveredMinor: 30_000 }],
    payments: [
      { paymentId: "PAY-202610-001-P1", method: "bank_transfer", paidOn: new Date("2026-11-03"), allocations: [{ lineId: L1, amountMinor: 300_000 }] },
      { paymentId: "PAY-202610-001-P2", method: "cash", paidOn: new Date("2026-11-04"), allocations: [{ lineId: L1, amountMinor: 210_000 }] },
      { paymentId: "PAY-202610-001-P0", method: "bank_transfer", paidOn: new Date("2026-11-06"), reversedAt: new Date("2026-11-07"), allocations: [{ lineId: L1, amountMinor: 999 }] },
    ],
  },
  {
    _id: new Types.ObjectId(), organizationId: ORG, runNumber: "PAY-202611-001", period: "2026-11", status: "approved", currency: "AED",
    lines: [line(L2, { payableMinor: 520_000 })], adjustments: [], payments: [],
  },
  {
    _id: new Types.ObjectId(), organizationId: ORG, runNumber: "PAY-202609-001", period: "2026-09", status: "voided", currency: "AED",
    lines: [line(new Types.ObjectId(), { amountPaidMinor: 1 })], adjustments: [], payments: [],
  },
] as any[]);

const exp = (n: string, o: Record<string, any>) => ({
  _id: new Types.ObjectId(), organizationId: ORG, expenseNumber: n, category: "travel_transport", subcategory: "business_taxi", categoryName: "Travel",
  description: `Expense ${n}`, expenseDate: new Date("2026-10-10"), totalMinor: 5_000, currency: "AED", status: "approved",
  salespersonId: REP, submittedById: OTHER, submittedByName: "Accounts", source: { kind: "manual" }, notes: "", ...o,
});
const ADV = exp("EX-00010", {
  category: "staff_advances", salespersonId: null, expenseDate: new Date("2026-10-20"), totalMinor: 100_000, description: "Salary advance — Rep One",
  source: { kind: "hrms_advance", key: "hrms-advance:o:1" }, notes: "Salary advance approved from HRMS.\nEmployee: Rep One (E0212)\nRecovered from pay: AED 500.00 a month × 2, from 2026-11.",
});
await db.collection("expenses").insertMany([
  exp("EX-00001", {}),
  exp("EX-00002", { salespersonId: null, submittedById: REP, submittedByName: "Rep One", status: "submitted", totalMinor: 2_500, expenseDate: new Date("2026-10-12") }),
  exp("EX-00003", { status: "rejected" }),
  exp("EX-00004", { source: { kind: "bill" } }),
  ADV,
  exp("EX-00011", { salespersonId: null, source: { kind: "hrms_one_time", key: "k2" }, notes: "Employee: Not Them (E02120)" }),
] as any[]);

const L = (q: Record<string, unknown> = {}) => personLedger(String(ORG), String(EMP), { page: 1, pageSize: 25, sort: "desc", ...q } as any);

try {
  step("1. The ledger: everything of theirs, newest first");
  let r = await L();
  check("their 3 invoices, 2 payroll months, 2 expenses and the advance — nothing void, rejected, a bill, voided or somebody else's",
    r.meta.total === 8 && r.counts.invoice === 3 && r.counts.payroll === 2 && r.counts.expense === 2 && r.counts.advance === 1 && r.counts.one_time === 0, show({ meta: r.meta, counts: r.counts }));
  check("newest first", r.rows.map((x) => x.reference).join() === "PAY-202611-001,PAY-202610-001,IN-00002,EX-00010,EX-00002,EX-00001,IN-00001,IN-00005", r.rows.map((x) => x.reference).join());
  const oct = r.rows.find((x) => x.reference === "PAY-202610-001")!;
  check("a payroll month: what it paid, dated the day the last of it went", oct.outMinor === 510_000 && oct.date.startsWith("2026-11-04") && oct.counted, show(oct));
  check("…its commission inside it, not a row of its own", /of which commission AED 300\.00/.test(oct.subtitle) && oct.facts.some((f) => f.label === "Of which commission" && f.minor === 30_000), oct.subtitle);
  const pays = oct.sections.find((s) => s.title === "Payments")?.items ?? [];
  check("…its payments, the reversed one said so", pays.length === 3 && pays.some((p) => /P0 .* reversed/.test(p.label)) && pays.some((p) => p.minor === 210_000), show(pays));
  const nov = r.rows.find((x) => x.reference === "PAY-202611-001")!;
  check("a month not paid yet: listed, owed, the month's last day, not counted", nov.outMinor === 0 && !nov.counted && nov.status === "pending" && nov.date.startsWith("2026-11-30"), show(nov));
  const adv = r.rows.find((x) => x.kind === "advance")!;
  check("the advance found by their employee code, recovered from pay, HRMS's notes with it",
    adv.outMinor === 100_000 && /Recovered/.test(adv.subtitle) && (adv.sections[0]?.items.length ?? 0) === 3, show(adv));
  check("…not one for E02120", !r.rows.some((x) => x.reference === "EX-00011"));
  const aed = r.totals.find((t) => t.currency === "AED"), inr = r.totals.find((t) => t.currency === "INR");
  check("totals per currency: AED brought in and paid/spent, the rupee invoice apart",
    aed?.inMinor === 325_000 && aed?.outMinor === 510_000 + 5_000 + 2_500 + 100_000 && inr?.inMinor === 6_000_000 && inr.outMinor === 0, show(r.totals));
  const inv2 = r.rows.find((x) => x.reference === "IN-00002")!;
  check("an invoice: its total brought in, paid and balance inside, a link to it",
    inv2.inMinor === 100_000 && inv2.facts.some((f) => f.label === "Balance" && f.minor === 60_000) && inv2.href === `/invoices/${IN2._id}`, show(inv2));

  step("2. Filtered, searched, sorted and paged by the server");
  r = await L({ kind: "payroll" });
  check("payroll only: its 2 months, AED paid 5,100", r.meta.total === 2 && r.rows.every((x) => x.kind === "payroll") && r.totals[0]?.outMinor === 510_000, show(r.totals));
  check("…the counts still say every kind", r.counts.invoice === 3, show(r.counts));
  r = await L({ q: "zara" });
  check("search by customer", r.meta.total === 1 && r.rows[0]?.reference === "IN-00002");
  r = await L({ q: "ex-0000" });
  check("search by number", r.meta.total === 2 && r.rows.every((x) => x.kind === "expense"));
  r = await L({ from: "2026-11-01", to: "2026-11-30" });
  check("November: the two payroll rows dated in it and IN-00002", r.rows.map((x) => x.reference).join() === "PAY-202611-001,PAY-202610-001,IN-00002", r.rows.map((x) => x.reference).join());
  r = await L({ sort: "asc" });
  check("oldest first", r.rows[0]?.reference === "IN-00005" && r.rows.at(-1)?.reference === "PAY-202611-001");
  r = await L({ pageSize: 3, page: 2 });
  check("page 2 of 3 a page", r.meta.pageCount === 3 && r.rows.map((x) => x.reference).join() === "EX-00010,EX-00002,EX-00001", show(r.meta));
  r = await L({ pageSize: 3, page: 9 });
  check("a page past the end: the last", r.meta.page === 3 && r.rows.length === 2, show(r.meta));
  const asLogin = await personLedger(String(ORG), `login-${OTHER}`, { page: 1, pageSize: 25, sort: "desc" });
  check("a login with no payroll record: their invoices, no payroll — and not the advances they approved as accounts",
    asLogin.meta.total === 1 && asLogin.rows[0]?.reference === "IN-00004", show(asLogin.rows.map((x) => x.reference)));

  step("3. CRM salespeople with no account: the backfill");
  const BLR = new Types.ObjectId(), BLR_ADMIN = new Types.ObjectId(), MEMBER = new Types.ObjectId();
  await db.collection("organizations").insertOne({ _id: BLR, name: "Delta Bangalore", baseCurrency: "INR" });
  await db.collection("users").insertMany([
    { _id: BLR_ADMIN, name: "ACCOUNTS BLR", email: "accounts@blr.test", passwordHash: "x", status: "active", memberships: [{ organizationId: BLR, roleId: ROLE, status: "active" }] },
    { _id: MEMBER, name: "Member Rep", email: "member@crm.test", passwordHash: "x", status: "active", memberships: [{ organizationId: BLR, roleId: ROLE, status: "active" }] },
  ] as any[]);
  const flagged = (n: string, name: string, email: string | null) => ({
    _id: new Types.ObjectId(), organizationId: BLR, invoiceNumber: n, customerName: "Student", salespersonId: BLR_ADMIN, salespersonName: "ACCOUNTS BLR",
    currency: "INR", status: "paid", totalMinor: 6_000_000, issueDate: new Date("2026-11-04"),
    enrolment: { course: "DPF", meetingBy: name, ...(email ? { meetingByEmail: email } : {}) },
    external: { source: "crm", externalId: n, flags: [`${name} has no account here — reassign this invoice to the right person.`, "\"DPF\" is not mapped to a catalogue item."] },
  });
  const B1 = flagged("IN-00027", "New Rep", "new.rep@crm.test");
  const B2 = flagged("IN-00028", "Somebody Else", "else@e2e.test");
  const B3 = flagged("IN-00029", "No Email", null);
  const B4 = flagged("IN-00030", "Member Rep", "member@crm.test");
  await db.collection("invoices").insertMany([B1, B2, B3, B4] as any[]);
  // Flags compared as a set (putting one back adds it at the end); the time a document was last saved left out.
  const plain = ({ updatedAt: _u, ...d }: any) => d;
  const snap = async () => JSON.stringify((await db.collection("invoices").find({ organizationId: BLR }).sort({ invoiceNumber: 1 }).toArray())
    .map((i: any) => plain({ ...i, external: { ...i.external, flags: [...(i.external?.flags ?? [])].sort() } })))
    + JSON.stringify((await db.collection("users").find({}).sort({ email: 1 }).toArray()).map(plain));
  const before = await snap();

  let b = await backfillCrmSalespeople({ write: false });
  const of = (n: string) => b.rows.find((x) => x.invoice === n);
  check("dry run: an account made, one joining from another organization, theirs here; the one with no email left",
    of("IN-00027")?.outcome === "would move" && /made/.test(of("IN-00027")!.detail)
    && /another organization/.test(of("IN-00028")!.detail) && /their account here/.test(of("IN-00030")!.detail)
    && of("IN-00029")?.outcome === "left" && b.rows.length === 4, show(b.rows));
  check("…nothing written", (await snap()) === before);
  let refused = ""; try { await backfillCrmSalespeople({ write: true, expect: 2 }); } catch (e) { refused = (e as Error).message; }
  check("--expect with the wrong count: refused, nothing written", /--expect 2, but 3/.test(refused) && (await snap()) === before, refused);

  const undoFile = join(mkdtempSync(join(tmpdir(), "crm-sp-")), "undo.json");
  b = await backfillCrmSalespeople({ write: true, expect: 3, undoFile });
  check("written: 3 moved, 1 left, the undo file saved", b.rows.filter((x) => x.outcome === "moved").length === 3 && existsSync(undoFile), show(b.rows));
  const made = await db.collection("users").findOne({ email: "new.rep@crm.test" }) as any;
  const payrollRole = await db.collection("roles").findOne({ organizationId: BLR, key: "payroll-employee" }) as any;
  check("…an account made for the new rep: the Payroll employee role here, no permissions",
    !!made && made.name === "New Rep" && String(made.memberships?.[0]?.roleId) === String(payrollRole?._id) && (payrollRole?.permissions ?? []).length === 0, show({ made, payrollRole }));
  const get = async (x: { _id: Types.ObjectId }) => db.collection("invoices").findOne({ _id: x._id }) as Promise<any>;
  const b1 = await get(B1);
  check("…IN-00027 is theirs, its salesperson and raised by, the flag gone, the other flag kept",
    String(b1.salespersonId) === String(made?._id) && b1.salespersonName === "New Rep"
    && !b1.external.flags.some((f: string) => /no account here/.test(f)) && b1.external.flags.some((f: string) => /not mapped/.test(f)), show(b1));
  const joined = await db.collection("users").findOne({ _id: OTHER }) as any;
  check("…the rep from another organization joins this one, with no access, and has IN-00028",
    joined.memberships.some((m: any) => String(m.organizationId) === String(BLR) && String(m.roleId) === String(payrollRole?._id)) && String((await get(B2)).salespersonId) === String(OTHER));
  check("…the member here has IN-00030; IN-00029 stays on the admin, flagged",
    String((await get(B4)).salespersonId) === String(MEMBER) && String((await get(B3)).salespersonId) === String(BLR_ADMIN) && (await get(B3)).external.flags.length === 2);
  b = await backfillCrmSalespeople({ write: false });
  check("run again: only the one with no email is left", b.rows.length === 1 && b.rows[0]?.invoice === "IN-00029", show(b.rows));

  const undone = await undoCrmSalespeople(undoFile);
  check("undo: the 3 back on the admin, flagged again; the account it made and the membership it added gone",
    undone.invoices === 3 && undone.removedUsers === 1 && undone.removedMemberships === 1 && (await snap()) === before, show(undone));

  step("4. The account helper itself");
  check("not an email: nothing made", (await ensureCrmSalesperson(String(BLR), "not-an-email", "X")) === null);
  const [a1, a2] = await Promise.all([ensureCrmSalesperson(String(BLR), "Twice@CRM.test", "Twice"), ensureCrmSalesperson(String(BLR), "twice@crm.test", "Twice")]);
  check("two enrolments at once: one account, both get it", String(a1?._id) === String(a2?._id) && (await db.collection("users").countDocuments({ email: "twice@crm.test" })) === 1);
} finally {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
