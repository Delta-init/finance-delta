/**
 * A client's name (and phone) put right, everywhere finance copied it (the user, 2026-10-31: a close for one person
 * was filed under the customer its email already belonged to, a name that wasn't theirs — "get the name and details
 * from the sales CRM and update it with a script").
 *
 * Finance knows a client by their email, and copies the customer's name onto what it makes for them — so renaming the
 * customer on its page leaves every invoice under the old name. This renames the customer (each organization's with
 * that email), sets their phone when one is given, and writes the new name on their invoices, credit notes,
 * quotations and sales orders, the CRM balance payments and CS Portal payments towards those invoices, and takes off
 * the "the client's email already belongs to <old name>" flag an invoice carries for it.
 *
 * Names come on the command line, never in this file. Reads and prints only, unless --write; --write first saves what
 * it changes to an undo file (--undo <file> puts it back). Run it from apps/api on the server (Bun reads MONGODB_URI
 * from the .env):
 *
 *   bun src/scripts/customer-rename.ts --email <their email> --name "<name>" [--phone "<phone>"]
 *   bun src/scripts/customer-rename.ts --email … --name "…" [--phone "…"] --write --expect N
 *   bun src/scripts/customer-rename.ts --undo <file>
 *
 * Look at what the dry run lists first: everything under the customer is renamed, so if any of it belongs to somebody
 * else sharing that email, this is the wrong tool — that close needs its own email in the CRM.
 */
import mongoose, { Types } from "mongoose";
import { writeFileSync, readFileSync } from "node:fs";

export interface RenameRow { kind: string; number: string; detail: string; from: string; to: string; change: boolean }

interface Undo {
  customers: Array<{ _id: string; name: string; phone: string }>;
  /** One field of one document, as it was. */
  fields: Array<{ model: string; _id: string; path: string; value: unknown }>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function models() {
  const [{ Customer }, { Invoice }, { CreditNote }, { Quotation }, { SalesOrder }, { BalancePaymentModel }, { TetraDepositModel }] = await Promise.all([
    import("../modules/customer/customer.model"),
    import("../modules/invoice/invoice.model"),
    import("../modules/credit-note/credit-note.model"),
    import("../modules/quotation/quotation.model"),
    import("../modules/salesorder/salesorder.model"),
    import("../modules/balance-payment/balance-payment.model"),
    import("../modules/tetra-deposit/tetra-deposit.model"),
  ]);
  return { Customer, Invoice, CreditNote, Quotation, SalesOrder, BalancePayment: BalancePaymentModel, TetraDeposit: TetraDepositModel } as Record<string, mongoose.Model<any>>;
}

export async function renameCustomer(opts: {
  email: string; name: string; phone?: string; write: boolean; expect?: number; undoFile?: string;
}): Promise<{ rows: RenameRow[]; changing: number; undoFile?: string }> {
  const email = opts.email.trim().toLowerCase();
  const name = opts.name.trim().replace(/\s+/g, " ");
  const phone = (opts.phone ?? "").trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("--email: the client's email");
  if (name.length < 2) throw new Error("--name: the client's name");
  if (phone && phone.replace(/\D/g, "").length < 7) throw new Error("--phone: a phone number, or leave it out");

  const M = await models();
  const customers = await M.Customer!.find({ email }).select("organizationId customerCode name phone").lean<any[]>();
  if (!customers.length) throw new Error(`No customer has the email ${email}`);

  const rows: RenameRow[] = [];
  type Change = { model: string; _id: Types.ObjectId; path: string; value: unknown; before: unknown };
  const sets: Change[] = [];
  const flagPulls: Array<{ _id: Types.ObjectId; flags: string[]; keep: string[] }> = [];
  const field = (model: string, doc: any, path: string, value: unknown, row: Omit<RenameRow, "change" | "to" | "from">) => {
    const before = path.split(".").reduce((o, k) => o?.[k], doc);
    const change = before !== value;
    rows.push({ ...row, from: String(before ?? ""), to: String(value), change });
    if (change) sets.push({ model, _id: doc._id, path, value, before });
  };

  for (const c of customers) {
    const nameChange = c.name !== name;
    const phoneChange = !!phone && c.phone !== phone;
    rows.push({
      kind: "customer", number: c.customerCode, detail: `${email}${phone ? ` · phone ${c.phone || "—"} → ${phone}` : ""}`,
      from: c.name, to: name, change: nameChange || phoneChange,
    });
    if (nameChange) sets.push({ model: "Customer", _id: c._id, path: "name", value: name, before: c.name });
    if (phoneChange) sets.push({ model: "Customer", _id: c._id, path: "phone", value: phone, before: c.phone });

    // What carries the "already belongs to <old name> (<code>)" flag for this customer.
    const wrongOwner = new RegExp(`already belongs to ${escape(c.name)} \\(${escape(c.customerCode)}\\)`);
    const invoices = await M.Invoice!.find({ customerId: c._id }).select("invoiceNumber customerName status issueDate enrolment.course external.flags").sort({ issueDate: 1 }).lean<any[]>();
    for (const inv of invoices) {
      const flags: string[] = inv.external?.flags ?? [];
      const keep = flags.filter((f) => !wrongOwner.test(f));
      const detail = [dayOf(inv.issueDate), inv.status, inv.enrolment?.course].filter(Boolean).join(" · ") + (keep.length < flags.length ? " · flag comes off" : "");
      field("Invoice", inv, "customerName", name, { kind: "invoice", number: inv.invoiceNumber, detail });
      if (keep.length < flags.length) {
        flagPulls.push({ _id: inv._id, flags, keep });
        rows[rows.length - 1]!.change = true;
      }
    }
    for (const [model, kind, numberField] of [["CreditNote", "credit note", "creditNoteNumber"], ["Quotation", "quotation", "quoteNumber"], ["SalesOrder", "sales order", "orderNumber"]] as const) {
      for (const d of await M[model]!.find({ customerId: c._id }).select(`${numberField} customerName status`).lean<any[]>()) {
        field(model, d, "customerName", name, { kind, number: String(d[numberField] ?? d._id), detail: String(d.status ?? "") });
      }
    }
    const ids = invoices.map((i) => i._id);
    for (const p of await M.BalancePayment!.find({ invoiceId: { $in: ids } }).select("invoiceNumber customerName status").lean<any[]>()) {
      field("BalancePayment", p, "customerName", name, { kind: "CRM balance payment", number: p.invoiceNumber, detail: String(p.status ?? "") });
    }
    for (const t of await M.TetraDeposit!.find({ "enrolmentPayment.invoiceId": { $in: ids }, "enrolmentPayment.invoice": { $exists: true } }).select("enrolmentPayment status").lean<any[]>()) {
      field("TetraDeposit", t, "enrolmentPayment.invoice.customerName", name, { kind: "CS Portal payment", number: t.enrolmentPayment?.invoiceNumber ?? "", detail: String(t.status ?? "") });
    }
  }

  const changing = rows.filter((r) => r.change).length;
  if (!opts.write) return { rows, changing };
  if (opts.expect !== undefined && opts.expect !== changing) {
    throw new Error(`--expect ${opts.expect}, but ${changing} would change now — run it again without --write and check`);
  }

  // Saved before anything changes, and read back whole.
  const undo: Undo = {
    customers: customers.map((c) => ({ _id: String(c._id), name: c.name, phone: c.phone })),
    fields: [
      ...sets.filter((s) => s.model !== "Customer").map((s) => ({ model: s.model, _id: String(s._id), path: s.path, value: s.before })),
      ...flagPulls.map((f) => ({ model: "Invoice", _id: String(f._id), path: "external.flags", value: f.flags })),
    ],
  };
  const undoFile = opts.undoFile ?? `customer-rename-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(undoFile, JSON.stringify(undo, null, 2));
  const back = JSON.parse(readFileSync(undoFile, "utf8")) as Undo;
  if (back.customers.length !== undo.customers.length || back.fields.length !== undo.fields.length) throw new Error(`The undo file ${undoFile} didn't read back whole — nothing changed`);

  for (const s of sets) await M[s.model]!.updateOne({ _id: s._id }, { $set: { [s.path]: s.value } });
  for (const f of flagPulls) await M.Invoice!.updateOne({ _id: f._id }, { $set: { "external.flags": f.keep } });
  return { rows, changing, undoFile };
}

/** Puts back what an undo file saved. */
export async function undoCustomerRename(file: string): Promise<number> {
  const M = await models();
  const saved = JSON.parse(readFileSync(file, "utf8")) as Undo;
  for (const c of saved.customers) await M.Customer!.updateOne({ _id: new Types.ObjectId(c._id) }, { $set: { name: c.name, phone: c.phone } });
  for (const f of saved.fields) await M[f.model]!.updateOne({ _id: new Types.ObjectId(f._id) }, { $set: { [f.path]: f.value } });
  return saved.customers.length + saved.fields.length;
}

function dayOf(d: unknown): string {
  return d ? new Date(d as string).toISOString().slice(0, 10) : "";
}

if (import.meta.main) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? String(process.argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    if (arg("--undo")) {
      console.log(`Put back ${await undoCustomerRename(arg("--undo"))} record(s) from ${arg("--undo")}.`);
    } else {
      const write = process.argv.includes("--write");
      const { rows, changing, undoFile } = await renameCustomer({
        email: arg("--email"), name: arg("--name"), phone: arg("--phone") || undefined, write,
        expect: arg("--expect") ? Number(arg("--expect")) : undefined,
      });
      for (const r of rows) console.log(`${r.change ? (write ? "changed " : "change  ") : "same    "} ${r.kind.padEnd(19)} ${r.number.padEnd(12)} ${r.from.slice(0, 24).padEnd(24)} → ${r.to.slice(0, 24).padEnd(24)} ${r.detail}`);
      console.log(`\n${rows.length} record(s), ${changing} ${write ? "changed" : "would change"}.`);
      if (undoFile) console.log(`Undo file: ${undoFile}`);
      if (!write) {
        const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
        console.log(`Nothing written. Check every record above is this one person's, then: bun src/scripts/customer-rename.ts --email ${arg("--email").trim().toLowerCase()} --name ${q(arg("--name").trim())}${arg("--phone") ? ` --phone ${q(arg("--phone").trim())}` : ""} --write --expect ${changing}`);
      }
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  await mongoose.disconnect();
}
