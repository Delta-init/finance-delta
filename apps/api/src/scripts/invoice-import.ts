/**
 * The old books' invoices brought into finance (the user, 2026-10-21: "we need import this invoice also, check currently
 * entered invoices also" — the Zoho exports, 5,561 invoices DMDT000937…DMDT006984, 2024-01 → 2026-10, all AED).
 *
 * The data file is made outside the repo (it holds clients' emails and phones) by
 * root/outputs/invoice-import/convert.py; this brings its invoices into one organization:
 *
 *   - each invoice with its DMDT number, dates, lines and 5% VAT (tax-inclusive, as the old books had it), its total
 *     checked to the fil; what was paid as one payment ("other", on the last payment date — the export has no more);
 *     paid, part-paid or owing as the balance says; created on its own date;
 *   - the client: finance's client of that email if there is one, else a new client (a client with no email gets an
 *     address that cannot receive mail, as finance needs one);
 *   - the salesperson: the finance user of exactly that name if only one has it, else one suspended "Old books" user
 *     (made once, never able to sign in); the old name is kept on every invoice;
 *   - history only (external.source "old_books"): no email, no reminder, no LMS, no commission, no bank line, never on
 *     the Approvals list (approval not required) or the "entered late" views;
 *   - already in finance — finance's own invoice for the same client and total within 10 days, or the same number —
 *     is skipped and listed; and finance's invoices from the same months with no match in the old books are listed
 *     too, to check. One imported before is skipped, so it can run again.
 *
 * Reads and prints only, unless --write. Run it from apps/api on the server (Bun reads MONGODB_URI from the .env), after
 * the API with this change is deployed:
 *
 *   bun src/scripts/invoice-import.ts --file <data.json> --org <id>              # what it would do
 *   … --write --expect <N>                                                    # do it, N as counted
 *   bun src/scripts/invoice-import.ts --undo backups/invoice-import-<time>.json [--write]
 *
 * Before writing, what it adds is saved to backups/invoice-import-<time>.json beside apps/api; --undo takes out exactly
 * that: the invoices, the clients it made that nothing else uses, and the "Old books" user if it made it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { OLD_BOOKS_SOURCE, computeInvoiceLine, sumInvoiceTotals, type InvoiceLineCalcInput } from "@delta/shared";
import { Organization } from "../modules/organization/organization.model";
import { User } from "../modules/user/user.model";
import { Customer } from "../modules/customer/customer.model";
import { Invoice } from "../modules/invoice/invoice.model";
import { Sequence } from "../modules/sequence/sequence.model";
import { hashPassword } from "../lib/password";

export interface ImportLine { name: string; desc: string; quantity: number; taxPct: number; lineTotalMinor: number; taxMinor: number }
export interface ImportInvoice {
  number: string;
  zohoId: string;
  file: string;
  date: string;
  dueDate: string;
  customer: { zohoId: string; name: string; email: string; phone: string };
  salesperson: string;
  currency: string;
  subtotalMinor: number;
  totalMinor: number;
  balanceMinor: number;
  paidMinor: number;
  lastPaymentDate: string | null;
  status: "paid" | "partial" | "overdue";
  notes: string;
  terms: string;
  reference: string;
  estimate: string;
  subject: string;
  lines: ImportLine[];
}
export interface ImportData { batch: string; invoices: ImportInvoice[] }

const MATCH_DAYS = 10;
const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
const money = (minor: number) => `AED ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const placeholderEmail = (orgId: string) => `old-books.${orgId}@imported.invalid`;
// Lower-case, as finance keeps every client's email.
const noEmail = (zohoCustomerId: string) => `no-email-${zohoCustomerId}@old-books.invalid`.toLowerCase();

export interface ImportPlan {
  org: string;
  orgId: string;
  batch: string;
  toImport: ImportInvoice[];
  already: number;
  sameNumber: { number: string; theirs: string }[];
  inFinance: { number: string; date: string; client: string; total: string; matches: string }[];
  onlyInFinance: { number: string; date: string; client: string; total: string }[];
  customers: { reused: number; toCreate: number };
  salespeople: { name: string; to: string; invoices: number }[];
  placeholderToCreate: boolean;
  taxDiffers: number;
  problems: string[];
  backup?: string;
}
export const countOf = (p: ImportPlan) => p.toImport.length + p.customers.toCreate + (p.placeholderToCreate ? 1 : 0);

function readData(file: string): ImportData {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as ImportData;
  if (!data.batch || !Array.isArray(data.invoices)) throw new Error(`${file} is not an invoice import data file`);
  return data;
}

/** Finance's lines for one old invoice: tax-inclusive, each line's total exactly the old books'. */
function linesFor(inv: ImportInvoice, taxCode: string) {
  const calc: InvoiceLineCalcInput[] = [];
  const lines = inv.lines.map((l) => {
    const whole = Number.isInteger(l.quantity) && l.quantity > 0 && l.lineTotalMinor % l.quantity === 0;
    const quantity = whole ? l.quantity : 1;
    const unitPriceMinor = whole ? l.lineTotalMinor / l.quantity : l.lineTotalMinor;
    const taxes = l.taxPct > 0 ? [{ code: taxCode, rate: l.taxPct }] : [];
    const input: InvoiceLineCalcInput = { quantity, unitPriceMinor, taxes, taxInclusive: true };
    calc.push(input);
    const b = computeInvoiceLine(input);
    const description = [l.name, l.desc, whole ? "" : `(× ${l.quantity})`].filter(Boolean).join(" — ");
    return {
      description,
      quantity,
      unitPriceMinor,
      discountPct: 0,
      taxes: b.taxes,
      lineSubtotalMinor: b.lineSubtotalMinor,
      discountMinor: b.discountMinor,
      taxableMinor: b.taxableMinor,
      taxTotalMinor: b.taxTotalMinor,
      lineTotalMinor: b.lineTotalMinor,
    };
  });
  return { lines, totals: sumInvoiceTotals(calc) };
}

export async function importInvoices(opts: { file: string; orgId: string; write: boolean; backupDir?: string; today?: Date }): Promise<ImportPlan> {
  const data = readData(opts.file);
  if (!Types.ObjectId.isValid(opts.orgId)) throw new Error("--org is not an organization id");
  const org = await Organization.findById(opts.orgId).select("name taxRates").lean<any>();
  if (!org) throw new Error(`No organization ${opts.orgId}`);
  const oid = org._id as Types.ObjectId;
  const vat = ((org.taxRates ?? []) as { code: string; rate: number; isDefault?: boolean; appliesTo?: string }[])
    .filter((r) => r.rate === 5 && r.appliesTo !== "purchases")
    .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault))[0];
  const taxCode = vat?.code ?? "VAT";
  const plan: ImportPlan = {
    org: org.name, orgId: String(oid), batch: data.batch, toImport: [], already: 0, sameNumber: [], inFinance: [], onlyInFinance: [],
    customers: { reused: 0, toCreate: 0 }, salespeople: [], placeholderToCreate: false, taxDiffers: 0, problems: [],
  };

  // What finance has: imported before, the same number, and its own invoices over the same months.
  const zohoIds = data.invoices.map((i) => i.zohoId);
  const imported = new Set(
    (await Invoice.find({ organizationId: oid, "external.source": OLD_BOOKS_SOURCE, "external.externalId": { $in: zohoIds } }).select("external.externalId").lean<any[]>())
      .map((i) => String(i.external.externalId)),
  );
  const sameNumbered = await Invoice.find({ organizationId: oid, invoiceNumber: { $in: data.invoices.map((i) => i.number) }, "external.source": { $ne: OLD_BOOKS_SOURCE } })
    .select("invoiceNumber customerName").lean<any[]>();
  const numbers = new Map(sameNumbered.map((i) => [String(i.invoiceNumber), String(i.customerName)]));
  const dates = data.invoices.map((i) => i.date).sort();
  const from = new Date(dayStart(dates[0]!).getTime() - MATCH_DAYS * 86_400_000);
  const to = new Date(dayStart(dates[dates.length - 1]!).getTime() + (MATCH_DAYS + 1) * 86_400_000);
  const own = await Invoice.find({ organizationId: oid, status: { $ne: "void" }, "external.source": { $ne: OLD_BOOKS_SOURCE }, issueDate: { $gte: from, $lt: to } })
    .select("invoiceNumber issueDate totalMinor customerId customerName").lean<any[]>();
  const ownCustomers = new Map(
    (await Customer.find({ _id: { $in: own.map((i) => i.customerId) } }).select("email name").lean<any[]>()).map((c) => [String(c._id), c]),
  );
  const byKey = new Map<string, any[]>();
  for (const i of own) {
    const c = ownCustomers.get(String(i.customerId));
    for (const k of [c?.email ? `e:${norm(c.email)}` : null, `n:${norm(i.customerName ?? c?.name ?? "")}`].filter(Boolean) as string[]) {
      byKey.set(k, [...(byKey.get(k) ?? []), i]);
    }
  }
  // A finance invoice of the same number is accounted for, not "only in finance".
  const matched = new Set<string>(sameNumbered.map((i) => String(i._id)));
  const firstDay = dates[0]!, lastDay = dates[dates.length - 1]!;

  const candidates: ImportInvoice[] = [];
  for (const inv of data.invoices) {
    if (imported.has(inv.zohoId)) { plan.already++; continue; }
    if (numbers.has(inv.number)) { plan.sameNumber.push({ number: inv.number, theirs: numbers.get(inv.number)! }); continue; }
    const keys = [inv.customer.email ? `e:${norm(inv.customer.email)}` : null, `n:${norm(inv.customer.name)}`].filter(Boolean) as string[];
    const at = dayStart(inv.date).getTime();
    let best: any = null;
    for (const k of keys) {
      for (const i of byKey.get(k) ?? []) {
        if (matched.has(String(i._id)) || i.totalMinor !== inv.totalMinor) continue;
        const gap = Math.abs(new Date(i.issueDate).getTime() - at);
        if (gap <= MATCH_DAYS * 86_400_000 && (!best || gap < best.gap)) best = { i, gap };
      }
      if (best) break;
    }
    if (best) {
      matched.add(String(best.i._id));
      plan.inFinance.push({ number: inv.number, date: inv.date, client: inv.customer.name, total: money(inv.totalMinor),
        matches: `${best.i.invoiceNumber} ${new Date(best.i.issueDate).toISOString().slice(0, 10)}` });
      continue;
    }
    candidates.push(inv);
  }
  for (const i of own) {
    const d = new Date(i.issueDate).toISOString().slice(0, 10);
    if (matched.has(String(i._id)) || d < firstDay || d > lastDay) continue;
    plan.onlyInFinance.push({ number: i.invoiceNumber, date: d, client: i.customerName ?? "", total: money(i.totalMinor ?? 0) });
  }

  // Lines and totals, checked.
  const built = new Map<string, ReturnType<typeof linesFor>>();
  for (const inv of candidates) {
    const b = linesFor(inv, taxCode);
    if (b.totals.totalMinor !== inv.totalMinor) { plan.problems.push(`${inv.number}: lines come to ${b.totals.totalMinor}, the old books say ${inv.totalMinor}`); continue; }
    if (inv.paidMinor > 0 && !inv.lastPaymentDate) { plan.problems.push(`${inv.number}: paid with no date`); continue; }
    const theirTax = inv.lines.reduce((t, l) => t + l.taxMinor, 0);
    if (b.totals.taxTotalMinor !== theirTax) plan.taxDiffers++;
    built.set(inv.number, b);
    plan.toImport.push(inv);
  }

  // Clients: finance's of that email, else new.
  const emailOf = (inv: ImportInvoice) => (inv.customer.email || noEmail(inv.customer.zohoId)).trim().toLowerCase();
  const wanted = [...new Set(plan.toImport.map(emailOf))];
  const existing = new Map(
    (await Customer.find({ organizationId: oid, email: { $in: wanted } }).select("email name").lean<any[]>()).map((c) => [String(c.email), c]),
  );
  plan.customers = { reused: wanted.filter((e) => existing.has(e)).length, toCreate: wanted.filter((e) => !existing.has(e)).length };

  // Salespeople: the one finance user of that name, else "Old books".
  const users = await User.find({ "memberships.organizationId": oid }).select("name").lean<any[]>();
  const byName = new Map<string, any[]>();
  for (const u of users) byName.set(norm(u.name ?? ""), [...(byName.get(norm(u.name ?? "")) ?? []), u]);
  const userFor = new Map<string, any | null>();
  const counts = new Map<string, number>();
  for (const inv of plan.toImport) {
    const n = inv.salesperson || "";
    counts.set(n, (counts.get(n) ?? 0) + 1);
    if (!userFor.has(n)) {
      const same = n ? byName.get(norm(n)) ?? [] : [];
      userFor.set(n, same.length === 1 ? same[0] : null);
    }
  }
  const placeholder = await User.findOne({ email: placeholderEmail(String(oid)) }).select("name").lean<any>();
  plan.placeholderToCreate = !placeholder && [...userFor.values()].some((u) => !u) && plan.toImport.length > 0;
  plan.salespeople = [...counts.entries()].sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ name: name || "(none)", to: userFor.get(name)?.name ?? "Old books (imported)", invoices: n }));

  if (!opts.write || plan.problems.length || !countOf(plan)) return plan;

  // What is about to be added, written down whole before anything is.
  const dir = opts.backupDir ?? path.resolve(process.cwd(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `invoice-import-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const backup = { at: new Date().toISOString(), batch: data.batch, orgId: String(oid), zohoIds: plan.toImport.map((i) => i.zohoId),
    customersCreated: [] as string[], placeholderCreated: null as string | null };
  const save = () => fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  save();
  if (JSON.parse(fs.readFileSync(file, "utf8")).zohoIds.length !== plan.toImport.length) throw new Error(`The backup ${file} did not read back whole — nothing written`);
  plan.backup = file;

  let oldBooks = placeholder;
  if (!oldBooks && plan.placeholderToCreate) {
    const made = await User.create({ name: "Old books (imported)", email: placeholderEmail(String(oid)), status: "suspended",
      passwordHash: await hashPassword(crypto.randomBytes(24).toString("base64url")), memberships: [] });
    oldBooks = { _id: made._id, name: made.name };
    backup.placeholderCreated = String(made._id);
    save();
  }

  // The clients it needs, numbered on from finance's own CUST- sequence.
  const create = wanted.filter((e) => !existing.has(e));
  if (create.length) {
    // After the highest CUST- number in use, as well as the counter: a client added some other way never shares one.
    const top = await Customer.aggregate<{ n: number }>([
      { $match: { organizationId: oid, customerCode: /^CUST-\d+$/ } },
      { $group: { _id: null, n: { $max: { $toInt: { $substrCP: ["$customerCode", 5, 20] } } } } },
    ]);
    const used = top[0]?.n ?? 0;
    await Sequence.updateOne({ organizationId: oid, key: "customer" }, { $max: { next: used }, $setOnInsert: { prefix: "CUST-" } }, { upsert: true });
    const seq = await Sequence.findOneAndUpdate({ organizationId: oid, key: "customer" }, { $inc: { next: create.length } }, { new: true });
    const first = (seq!.next as number) - create.length + 1;
    const sample = new Map(plan.toImport.map((i) => [emailOf(i), i]));
    const docs = create.map((email, k) => {
      const inv = sample.get(email)!;
      const d = new Customer({ organizationId: oid, customerCode: `CUST-${String(first + k).padStart(5, "0")}`, name: inv.customer.name || "Client",
        email, phone: inv.customer.phone || "-", currency: "AED" });
      const err = d.validateSync();
      if (err) throw new Error(`Client ${email}: ${err.message}`);
      const at = dayStart(inv.date);
      return { ...d.toObject(), createdAt: at, updatedAt: at };
    });
    for (let i = 0; i < docs.length; i += 500) await Customer.collection.insertMany(docs.slice(i, i + 500) as any[], { ordered: true });
    for (const d of docs) existing.set(String(d.email), { _id: d._id, name: d.name });
    backup.customersCreated = docs.map((d) => String(d._id));
    save();
  }

  const today = opts.today ?? new Date();
  const docs = plan.toImport.map((inv) => {
    const b = built.get(inv.number)!;
    const cust = existing.get(emailOf(inv))!;
    const sp = userFor.get(inv.salesperson || "") ?? oldBooks;
    const issue = dayStart(inv.date), due = dayStart(inv.dueDate || inv.date);
    const status = inv.balanceMinor === 0 ? "paid" : inv.paidMinor > 0 ? "partial" : due < today ? "overdue" : "sent";
    const d = new Invoice({
      organizationId: oid,
      invoiceNumber: inv.number,
      customerId: cust._id, customerName: inv.customer.name || cust.name,
      salespersonId: sp._id, salespersonName: inv.salesperson || "Old books",
      approval: { state: "not_required" },
      external: { source: OLD_BOOKS_SOURCE, externalId: inv.zohoId, flags: [] },
      reference: inv.reference,
      status,
      issueDate: issue, dueDate: due,
      currency: "AED", exchangeRate: 1, taxInclusive: true,
      lineItems: b.lines,
      subtotalMinor: b.totals.subtotalMinor, discountTotalMinor: b.totals.discountTotalMinor, taxBreakdown: b.totals.taxBreakdown,
      taxTotalMinor: b.totals.taxTotalMinor, totalMinor: b.totals.totalMinor, baseTotalMinor: b.totals.totalMinor,
      amountPaidMinor: inv.paidMinor, balanceMinor: inv.balanceMinor,
      notes: inv.notes, terms: inv.terms,
      payments: inv.paidMinor > 0 ? [{
        method: "other", amountMinor: inv.paidMinor, paidOn: dayStart(inv.lastPaymentDate!),
        reference: "Old books", externalRef: `${OLD_BOOKS_SOURCE}:${inv.zohoId}`,
        notes: "Paid in the old books by this date — how, and in how many payments, the export does not say.",
      }] : [],
    });
    const err = d.validateSync();
    if (err) throw new Error(`${inv.number}: ${err.message}`);
    return { ...d.toObject({ depopulate: true }), createdAt: issue, updatedAt: issue };
  });
  for (let i = 0; i < docs.length; i += 500) await Invoice.collection.insertMany(docs.slice(i, i + 500) as any[], { ordered: true });
  return plan;
}

/** Takes out what a run added, from its backup: the invoices, the clients it made if nothing else uses them, the "Old books" user if it made it. */
export async function undoImport(file: string, write: boolean): Promise<string[]> {
  const b = JSON.parse(fs.readFileSync(file, "utf8")) as { orgId: string; zohoIds: string[]; customersCreated: string[]; placeholderCreated: string | null };
  const oid = new Types.ObjectId(b.orgId);
  const n = await Invoice.countDocuments({ organizationId: oid, "external.source": OLD_BOOKS_SOURCE, "external.externalId": { $in: b.zohoIds } });
  const out = [`${b.orgId}: ${n} imported invoice(s) out; up to ${b.customersCreated.length} client(s) it made out if unused${b.placeholderCreated ? "; the Old books user out if unused" : ""}`];
  if (!write) return out;
  for (let i = 0; i < b.zohoIds.length; i += 1000) {
    await Invoice.deleteMany({ organizationId: oid, "external.source": OLD_BOOKS_SOURCE, "external.externalId": { $in: b.zohoIds.slice(i, i + 1000) } });
  }
  const ids = b.customersCreated.map((s) => new Types.ObjectId(s));
  const used = new Set((await Invoice.distinct("customerId", { customerId: { $in: ids } })).map(String));
  const free = ids.filter((id) => !used.has(String(id)));
  for (let i = 0; i < free.length; i += 1000) await Customer.deleteMany({ _id: { $in: free.slice(i, i + 1000) } });
  if (b.placeholderCreated && !(await Invoice.exists({ salespersonId: new Types.ObjectId(b.placeholderCreated) }))) {
    await User.deleteOne({ _id: new Types.ObjectId(b.placeholderCreated) });
  }
  out.push(`taken out: ${n} invoice(s), ${free.length} client(s)`);
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : undefined; };
  const write = argv.includes("--write");
  const { connectDb } = await import("../config/db");
  await connectDb();

  const undo = arg("--undo");
  if (undo) {
    for (const l of await undoImport(undo, write)) console.log(l);
    if (!write) console.log("\nNothing written — run again with --write.");
    await mongoose.disconnect();
    process.exit(0);
  }
  const file = arg("--file"), orgId = arg("--org");
  if (!file || !orgId) { console.error("--file <data.json> --org <organization id> are required"); process.exit(1); }

  const print = (p: ImportPlan) => {
    console.log(`== ${p.org} (${p.orgId}) — batch ${p.batch}`);
    for (const pr of p.problems) console.log(`  PROBLEM: ${pr}`);
    const byYear = new Map<string, { n: number; t: number; owed: number; st: Record<string, number> }>();
    for (const i of p.toImport) {
      const y = byYear.get(i.date.slice(0, 4)) ?? { n: 0, t: 0, owed: 0, st: {} };
      y.n++; y.t += i.totalMinor; y.owed += i.balanceMinor; y.st[i.status] = (y.st[i.status] ?? 0) + 1;
      byYear.set(i.date.slice(0, 4), y);
    }
    console.log("\n  To import, by year:");
    for (const [y, v] of [...byYear.entries()].sort()) console.log(`    ${y}  ${String(v.n).padStart(5)} invoices  ${money(v.t).padStart(18)} invoiced  ${money(v.owed).padStart(16)} owed  ${JSON.stringify(v.st)}`);
    const t = p.toImport.reduce((s, i) => s + i.totalMinor, 0), owed = p.toImport.reduce((s, i) => s + i.balanceMinor, 0);
    console.log(`    all   ${String(p.toImport.length).padStart(5)} invoices  ${money(t).padStart(18)} invoiced  ${money(owed).padStart(16)} owed`);
    console.log(`\n  Clients: ${p.customers.reused} already in finance (by email), ${p.customers.toCreate} to add${p.placeholderToCreate ? '; the "Old books (imported)" user to add (suspended — cannot sign in)' : ""}`);
    console.log(`  ${p.already} imported before; ${p.taxDiffers} whose VAT finance works out a fil differently (totals the same)`);
    console.log("\n  Salespeople (old books → finance):");
    for (const s of p.salespeople) console.log(`    ${s.name.padEnd(28)} → ${s.to.padEnd(28)} ${s.invoices}`);
    if (p.sameNumber.length) {
      console.log(`\n  ${p.sameNumber.length} skipped — finance already has an invoice with that number:`);
      for (const x of p.sameNumber) console.log(`    ${x.number}  (finance's: ${x.theirs})`);
    }
    console.log(`\n  ${p.inFinance.length} skipped — already in finance (same client, same total, within ${MATCH_DAYS} days):`);
    for (const x of p.inFinance) console.log(`    ${x.number} ${x.date} ${x.total.padStart(14)}  ${x.client.slice(0, 30).padEnd(30)} = ${x.matches}`);
    console.log(`\n  ${p.onlyInFinance.length} of finance's own invoices in the same months have no match in the old books:`);
    for (const x of p.onlyInFinance) console.log(`    ${x.number.padEnd(12)} ${x.date} ${x.total.padStart(14)}  ${x.client}`);
  };
  const dry = await importInvoices({ file, orgId, write: false });
  if (write && !dry.problems.length) {
    const expect = Number(arg("--expect"));
    if (expect !== countOf(dry)) {
      print(dry);
      console.error(`\nRefusing to write: ${countOf(dry)} change(s), and --expect ${arg("--expect") ?? "(missing)"} was given.`);
      await mongoose.disconnect();
      process.exit(1);
    }
    const done = await importInvoices({ file, orgId, write: true });
    print(done);
    console.log(`\n${countOf(done)} change(s) written. Backup: ${done.backup}\nUndo: bun src/scripts/invoice-import.ts --undo ${done.backup} --write`);
  } else {
    print(dry);
    console.log(dry.problems.length
      ? "\nNothing written — fix the problems above first."
      : `\n${countOf(dry)} change(s): ${dry.toImport.length} invoice(s), ${dry.customers.toCreate} client(s)${dry.placeholderToCreate ? ", 1 user" : ""}. Nothing written — run again with --write --expect ${countOf(dry)}.`);
  }
  await mongoose.disconnect();
}
