/**
 * scripts/customer-rename.ts (the user, 2026-10-31: a close filed under the customer its email already belonged to,
 * under a name that wasn't the client's), against a scratch database.
 *
 * What it proves: the dry run lists the customer and everything carrying their name, and writes nothing; --expect with
 * the wrong count is refused; --write renames the customer (every organization's with that email), sets the phone,
 * writes the name on invoices, credit notes, quotations, sales orders, CRM balance payments and CS Portal payments,
 * and takes off only the "already belongs to <old name>" flag; another customer is untouched; a second run has
 * nothing to do; the undo file puts it all back; bad arguments are refused.
 *
 * Run through scripts/customer-rename-e2e.sh (throwaway mongod, no .env anywhere).
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const { renameCustomer, undoCustomerRename } = await import("./customer-rename");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const same = (label: string, got: unknown, want: unknown) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
async function refused(p: Promise<unknown>, like: RegExp): Promise<boolean> {
  try { await p; return false; } catch (e) { return like.test((e as Error).message); }
}

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

const ORG = new Types.ObjectId(), OTHER = new Types.ObjectId();
const EMAIL = "client.one@e2e.local";
const OLD = "old_handle", NEW = "New Person", WRONG = `The client's email already belongs to ${OLD} (CUST-00001) — this close is for ${NEW}. It was filed under ${OLD}; check before approving, and send it back for the client's own email.`;
const c1 = new Types.ObjectId(), c2 = new Types.ObjectId(), c3 = new Types.ObjectId();
await db.collection("customers").insertMany([
  { _id: c1, organizationId: ORG, customerCode: "CUST-00001", name: OLD, email: EMAIL, phone: "+971 50 000 0001" },
  { _id: c2, organizationId: OTHER, customerCode: "CUST-00007", name: OLD, email: EMAIL, phone: "Not given" },     // the same email, another organization
  { _id: c3, organizationId: ORG, customerCode: "CUST-00002", name: "Someone Else", email: "else@e2e.local", phone: "+971 50 000 0002" },
]);
const i1 = new Types.ObjectId(), i2 = new Types.ObjectId(), i3 = new Types.ObjectId(), iElse = new Types.ObjectId();
const inv = (o: Record<string, unknown>) => ({ organizationId: ORG, customerId: c1, customerName: OLD, status: "draft", issueDate: new Date("2026-10-31"), totalMinor: 100, external: { flags: [] }, ...o });
await db.collection("invoices").insertMany([
  inv({ _id: i1, invoiceNumber: "IN-1", enrolment: { course: "Course A" }, external: { source: "crm", flags: [WRONG, "Another flag stays"] } }),
  inv({ _id: i2, invoiceNumber: "IN-2", status: "paid" }),
  inv({ _id: i3, invoiceNumber: "IN-3", organizationId: OTHER, customerId: c2 }),
  inv({ _id: iElse, invoiceNumber: "IN-9", customerId: c3, customerName: "Someone Else" }),
]);
await db.collection("creditnotes").insertOne({ organizationId: ORG, customerId: c1, customerName: OLD, creditNoteNumber: "CN-1", invoiceId: i2, invoiceNumber: "IN-2", status: "issued", totalMinor: 10 });
await db.collection("quotations").insertOne({ organizationId: ORG, customerId: c1, customerName: OLD, quoteNumber: "QT-1", status: "sent" });
await db.collection("salesorders").insertOne({ organizationId: ORG, customerId: c1, customerName: OLD, orderNumber: "SO-1", status: "open" });
await db.collection("balancepayments").insertOne({ organizationId: ORG, invoiceId: i2, invoiceNumber: "IN-2", customerName: OLD, status: "approved", source: "crm", externalId: "x", amountMinor: 1, currency: "AED", method: "cash", paidOn: "2026-10-31" });
await db.collection("tetradeposits").insertOne({ organizationId: ORG, type: "ENROLMENT_PAYMENT", status: "APPROVED", student: { name: NEW }, enrolmentPayment: { invoiceId: i2, invoiceNumber: "IN-2", paidOn: "2026-10-31", invoice: { customerName: OLD, course: "Course A" } } });

const names = async () => ({
  customers: (await db.collection("customers").find({ email: EMAIL }).sort({ customerCode: 1 }).toArray()).map((c) => [c.name, c.phone]),
  invoices: (await db.collection("invoices").find({}).sort({ invoiceNumber: 1 }).toArray()).map((i) => [i.invoiceNumber, i.customerName, i.external?.flags ?? []]),
  others: [
    (await db.collection("creditnotes").findOne({}))?.customerName, (await db.collection("quotations").findOne({}))?.customerName,
    (await db.collection("salesorders").findOne({}))?.customerName, (await db.collection("balancepayments").findOne({}))?.customerName,
    (await db.collection("tetradeposits").findOne({}))?.enrolmentPayment?.invoice?.customerName,
  ],
});
const before = await names();

step("1. Dry run");
const dry = await renameCustomer({ email: " Client.One@e2e.local ", name: ` ${NEW} `, phone: "+974 3000 1904", write: false });
same("lists both customers with that email, their 3 invoices, the credit note, quotation, sales order, balance payment and CS Portal payment",
  dry.rows.map((r) => [r.kind, r.number]).sort(),
  [["CRM balance payment", "IN-2"], ["CS Portal payment", "IN-2"], ["credit note", "CN-1"], ["customer", "CUST-00001"], ["customer", "CUST-00007"],
    ["invoice", "IN-1"], ["invoice", "IN-2"], ["invoice", "IN-3"], ["quotation", "QT-1"], ["sales order", "SO-1"]].sort());
check("…every one would change; the flag is said to come off IN-1", dry.changing === 10 && /flag comes off/.test(dry.rows.find((r) => r.number === "IN-1")?.detail ?? ""), JSON.stringify(dry.rows));
same("…nothing written", await names(), before);

step("2. Refusals");
check("--expect with the wrong count", await refused(renameCustomer({ email: EMAIL, name: NEW, write: true, expect: 3 }), /--expect 3, but 10/));
same("…nothing written", await names(), before);
check("an email nobody has", await refused(renameCustomer({ email: "nobody@e2e.local", name: NEW, write: false }), /No customer/));
check("no name", await refused(renameCustomer({ email: EMAIL, name: " ", write: false }), /--name/));
check("a phone that isn't one", await refused(renameCustomer({ email: EMAIL, name: NEW, phone: "n/a", write: false }), /--phone/));

step("3. Written");
const undoFile = `${process.env.TMPDIR ?? "/tmp"}/customer-rename-e2e-${Date.now()}.json`;
const done = await renameCustomer({ email: EMAIL, name: NEW, phone: "+974 3000 1904", write: true, expect: 10, undoFile });
const after = await names();
same("both customers renamed, with the phone", after.customers, [[NEW, "+974 3000 1904"], [NEW, "+974 3000 1904"]]);
same("their invoices renamed; only the wrong-owner flag off IN-1; someone else's invoice untouched", after.invoices,
  [["IN-1", NEW, ["Another flag stays"]], ["IN-2", NEW, []], ["IN-3", NEW, []], ["IN-9", "Someone Else", []]]);
same("credit note, quotation, sales order, balance payment and CS Portal payment renamed", after.others, [NEW, NEW, NEW, NEW, NEW]);
check("Someone Else's customer untouched", (await db.collection("customers").findOne({ _id: c3 }))?.name === "Someone Else");
const again = await renameCustomer({ email: EMAIL, name: NEW, phone: "+974 3000 1904", write: false });
check("run again: nothing more to change", again.changing === 0, JSON.stringify(again.rows.filter((r) => r.change)));

step("4. Undo");
await undoCustomerRename(done.undoFile ?? undoFile);
same("everything back as it was, the flag too", await names(), before);

await mongoose.disconnect();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
