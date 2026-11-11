import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import {
  importKey,
  parseImportDate,
  parseImportMethod,
  parseImportPct,
  type BillImportInput,
  type BillImportRow,
  type CreateBillInput,
  type ExpensePaymentMethod,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportResult,
  type ImportResultRow,
} from "@delta/shared";
import { logger } from "../../lib/logger";
import { Bill } from "../bill/bill.model";
import { createBill, recordBillPayment } from "../bill/bill.service";
import { Vendor } from "../vendor/vendor.model";
import { createVendor } from "../vendor/vendor.service";
import {
  dayAfter, dayOf, loadImportContext, matchAccount, matchAmount, matchCategory, matchCurrency, matchText, methodOfAccount,
  newImportBatchId, type ImportContext,
} from "./import-lookup";
import { countStatuses } from "./expense-import.service";

/*
 * Bills from a spreadsheet (the user, 2026-11-11: "Import option required in Bills").
 *
 * Each row is one bill with one line: the vendor (by name — one not on file yet is added, for whoever may add vendors),
 * the vendor's own bill number, its date and due date, category and subcategory, what it was for, the amount before
 * tax and the tax rate. Made through createBill, so it is numbered, approved and given its own expense
 * (bill-expense.ts) as when typed. With Paid on and Paid from it is also paid in full from that account through
 * recordBillPayment — its line in Banking — otherwise it stays unpaid. Imported bills are history: no late actor, so an
 * old date is not sent to a manager.
 *
 * A row the books already have is skipped: the same vendor and bill number — or, when either side has no number, the
 * same vendor, bill date, total and currency — among bills not voided and the rows above it in the file.
 */

interface VendorRef {
  /** Matched by this. */
  key: string;
  name: string;
  /** On file; absent for one the import adds. */
  id?: string;
  currency: string;
  /** Its last bill's terms ("Net 30"), for the due date when the row has none. */
  terms: string;
}

interface Ready {
  row: number;
  vendor: VendorRef;
  billNumber: string;
  billDate: string;
  dueDate: string;
  paymentTerms: string;
  category: string;
  subcategory: string | null;
  categoryName: string;
  subcategoryName: string;
  description: string;
  amountMinor: number;
  taxPct: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
  payment: { paidOn: string; account: { id: string; name: string }; method: ExpensePaymentMethod } | null;
  notes: string;
}

type Checked = { row: number; ok: true; v: Ready } | { row: number; ok: false; message: string; seen: Partial<ImportPreviewRow> };

interface VendorBook {
  /** Every vendor on file, by name in lower case. */
  byKey: Map<string, { id: string; name: string; currency: string; active: boolean }[]>;
  terms: Map<string, string>;
}

/** The vendors on file, and each one's latest payment terms. */
async function loadVendors(orgId: string): Promise<VendorBook> {
  const org = new Types.ObjectId(orgId);
  const [vendors, terms] = await Promise.all([
    Vendor.find({ organizationId: org }).select("name currency status").lean<any[]>(),
    Bill.aggregate<{ _id: Types.ObjectId; terms: string }>([
      { $match: { organizationId: org, status: { $ne: "voided" }, paymentTerms: { $nin: ["", null] } } },
      { $sort: { billDate: -1, createdAt: -1 } },
      { $group: { _id: "$vendorId", terms: { $first: "$paymentTerms" } } },
    ]),
  ]);
  const byKey = new Map<string, { id: string; name: string; currency: string; active: boolean }[]>();
  for (const v of vendors) {
    const k = importKey(v.name);
    byKey.set(k, [...(byKey.get(k) ?? []), { id: String(v._id), name: String(v.name), currency: String(v.currency ?? ""), active: v.status !== "archived" }]);
  }
  return { byKey, terms: new Map(terms.map((t) => [String(t._id), String(t.terms)])) };
}

/** Days a vendor's terms give to pay: "Net 30" → 30, "Due on receipt" → 0; unknown → null. */
function termDays(terms: string): number | null {
  const net = terms.match(/net\s*(\d{1,3})/i);
  if (net) return Number(net[1]);
  return /receipt|immediate/i.test(terms) ? 0 : null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function checkRow(ctx: ImportContext, book: VendorBook, r: BillImportRow, fmt: BillImportInput["dateFormat"], canAddVendors: boolean): Checked {
  const problems: string[] = [];
  const take = <T>(m: { ok: true; value: T } | { ok: false; message: string }): T | undefined => {
    if (m.ok) return m.value;
    problems.push(m.message);
    return undefined;
  };

  let vendor: VendorRef | undefined;
  const vendorName = take(matchText(r.vendor, "Vendor", 120, true));
  if (vendorName) {
    const found = book.byKey.get(importKey(vendorName)) ?? [];
    const open = found.filter((v) => v.active);
    if (open.length > 1) problems.push(`More than one vendor is called '${vendorName}'`);
    else if (found.length) {
      const v = open[0] ?? found[0]!;
      vendor = { key: importKey(vendorName), name: v.name, id: v.id, currency: v.currency, terms: book.terms.get(v.id) ?? "" };
    } else if (vendorName.length < 2) problems.push("Vendor name is too short");
    else if (!canAddVendors) problems.push(`Vendor '${vendorName}' not found — you can't add vendors; add it first or ask someone who can`);
    else vendor = { key: importKey(vendorName), name: vendorName, currency: "", terms: "" };
  }

  const billNumber = take(matchText(r.billNumber, "Bill number", 120));
  const bd = parseImportDate(r.billDate, fmt);
  if (!bd.ok) problems.push(r.billDate.trim() ? `Bill date: ${bd.reason}` : "No bill date");
  const dd = r.dueDate.trim() ? parseImportDate(r.dueDate, fmt) : null;
  if (dd && !dd.ok) problems.push(`Due date: ${dd.reason}`);
  const cat = take(matchCategory(ctx, r.category, r.subcategory));
  const description = take(matchText(r.description, "Description", 500, true));
  const amount = take(matchAmount(r.amount));
  const pct = parseImportPct(r.taxPct);
  if (!pct.ok) problems.push(pct.reason);
  // Left blank: the vendor's currency, then the organization's.
  const currency = take(matchCurrency(r.currency, vendor?.currency || ctx.baseCurrency));
  const method = parseImportMethod(r.paymentMethod);
  if (!method.ok) problems.push(method.reason);
  const notes = take(matchText(r.notes, "Notes", 2000));

  // Paid: both or neither.
  let payment: Ready["payment"] = null;
  const hasPaidOn = !!r.paidOn.trim(), hasPaidFrom = !!r.paidFrom.trim();
  if (hasPaidOn !== hasPaidFrom) {
    problems.push(hasPaidOn ? "Paid on is given without Paid from — give both to record the payment" : "Paid from is given without Paid on — give both to record the payment");
  } else if (hasPaidOn) {
    const po = parseImportDate(r.paidOn, fmt);
    if (!po.ok) problems.push(`Paid on: ${po.reason}`);
    const acc = currency ? take(matchAccount(ctx, r.paidFrom, currency, "bill")) : undefined;
    if (po.ok && acc) payment = { paidOn: po.iso, account: { id: acc.id, name: acc.name }, method: (method.ok && method.method) || methodOfAccount(acc) };
  }

  let dueDate = "", paymentTerms = "";
  if (bd.ok) {
    if (dd?.ok) dueDate = dd.iso;
    else if (!dd) {
      // From the vendor's terms on its last bill, else the bill date.
      const days = vendor?.terms ? termDays(vendor.terms) : null;
      dueDate = addDays(bd.iso, days ?? 0);
      if (days !== null) paymentTerms = vendor!.terms;
    }
    if (dueDate && dueDate < bd.iso) problems.push(`Due date ${dueDate} is before the bill date ${bd.iso} — is the date format right?`);
  }

  if (problems.length || !vendor || billNumber === undefined || !bd.ok || !dueDate || !cat || description === undefined || amount === undefined
    || !pct.ok || !currency || !method.ok || notes === undefined) {
    return {
      row: r.row, ok: false, message: problems.join(" · ") || "Could not be read",
      seen: { vendorName: r.vendor.trim() || undefined, date: bd.ok ? bd.iso : undefined, description: r.description.trim() || undefined },
    };
  }
  const taxPct = pct.pct ?? 0;
  // One line, quantity 1 — the same sums as the bill service's.
  const taxMinor = Math.round((amount * taxPct) / 100);
  return {
    row: r.row,
    ok: true,
    v: {
      row: r.row, vendor, billNumber, billDate: bd.iso, dueDate, paymentTerms, ...cat, description,
      amountMinor: amount, taxPct, taxMinor, totalMinor: amount + taxMinor, currency, payment, notes,
    },
  };
}

interface Seen {
  vendorKey: string;
  vendorId?: string;
  billNumber: string;
  billDate: string;
  totalMinor: number;
  currency: string;
  id?: string;
  number?: string;
  row?: number;
}

function same(a: Seen, b: Seen): boolean {
  const vendor = a.vendorId && b.vendorId ? a.vendorId === b.vendorId : a.vendorKey === b.vendorKey;
  if (!vendor) return false;
  if (a.billNumber && b.billNumber) return importKey(a.billNumber) === importKey(b.billNumber);
  return a.billDate === b.billDate && a.totalMinor === b.totalMinor && a.currency === b.currency;
}

const seenOf = (v: Ready): Seen => ({
  vendorKey: v.vendor.key, vendorId: v.vendor.id, billNumber: v.billNumber, billDate: v.billDate, totalMinor: v.totalMinor, currency: v.currency, row: v.row,
});

/** The bills on file of the vendors the rows name, not voided. */
async function existingFor(orgId: string, ready: Ready[]): Promise<Seen[]> {
  const ids = [...new Set(ready.flatMap((v) => (v.vendor.id ? [v.vendor.id] : [])))];
  if (!ids.length) return [];
  const rows = await Bill.find({ organizationId: new Types.ObjectId(orgId), vendorId: { $in: ids.map((id) => new Types.ObjectId(id)) }, status: { $ne: "voided" } })
    .select("vendorId vendorName billNumber reference billDate totalMinor currency").lean<any[]>();
  return rows.map((b) => ({
    vendorKey: importKey(b.vendorName), vendorId: String(b.vendorId), billNumber: String(b.reference ?? ""), billDate: dayOf(b.billDate),
    totalMinor: b.totalMinor ?? 0, currency: String(b.currency ?? "AED"), id: String(b._id), number: String(b.billNumber ?? ""),
  }));
}

function duplicateMessage(d: Seen): string {
  if (d.number && d.row) return `Same as row ${d.row} (${d.number})`;
  return d.number ? `Already entered as ${d.number}` : `Same as row ${d.row}`;
}

function view(v: Ready): ImportPreviewRow {
  return {
    row: v.row, status: "ok", vendorName: v.vendor.name, ...(v.vendor.id ? {} : { newVendor: true }),
    ...(v.billNumber ? { billNumber: v.billNumber } : {}),
    date: v.billDate, dueDate: v.dueDate, description: v.description, categoryName: v.categoryName,
    ...(v.subcategoryName ? { subcategoryName: v.subcategoryName } : {}),
    netMinor: v.amountMinor, taxMinor: v.taxMinor, totalMinor: v.totalMinor, taxPct: v.taxPct, currency: v.currency,
    ...(v.payment ? { paidOn: v.payment.paidOn, accountName: v.payment.account.name, paymentMethod: v.payment.method } : {}),
  };
}

export interface BillImportWho {
  /** Holds vendor:create (or is a super admin): a vendor not on file is added; otherwise its rows are refused. */
  canAddVendors: boolean;
}

/** Every row checked against the books and the rows above it, and the vendors that would be added. Writes nothing. */
export async function previewBillImport(orgId: string, input: BillImportInput, who: BillImportWho): Promise<ImportPreview> {
  const [ctx, book] = await Promise.all([loadImportContext(orgId), loadVendors(orgId)]);
  const checked = input.rows.map((r) => checkRow(ctx, book, r, input.dateFormat, who.canAddVendors));
  const existing = await existingFor(orgId, checked.flatMap((c) => (c.ok ? [c.v] : [])));
  const earlier: Seen[] = [];
  const newVendors = new Map<string, string>();
  const rows = checked.map((c): ImportPreviewRow => {
    if (!c.ok) return { row: c.row, status: "error", message: c.message, ...c.seen };
    const me = seenOf(c.v);
    const dup = existing.find((e) => same(e, me)) ?? earlier.find((e) => same(e, me));
    if (dup) return { ...view(c.v), status: "duplicate", message: duplicateMessage(dup), duplicateOf: { id: dup.id, number: dup.number, row: dup.row } };
    earlier.push(me);
    if (!c.v.vendor.id && !newVendors.has(c.v.vendor.key)) newVendors.set(c.v.vendor.key, c.v.vendor.name);
    return view(c.v);
  });
  return { rows, counts: countStatuses(rows), newVendors: [...newVendors.values()] };
}

/**
 * A vendor the import adds: its name, and the currency of its first row. Nothing in the sheet says how to reach it, so
 * its email is a stand-in at a domain that never receives mail and its phone says it was not given — both to be filled
 * in on the vendor's page.
 */
async function addVendor(orgId: string, v: Ready): Promise<{ id: string; name: string }> {
  const slug = v.vendor.key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "vendor";
  const made = await createVendor(orgId, {
    name: v.vendor.name,
    email: `${slug}-${randomBytes(3).toString("hex")}@no-email.invalid`,
    phone: "Not given",
    companyName: "",
    currency: v.currency,
    vatNumber: "",
    billingAddress: { street: "", city: "", state: "", zip: "", country: "" },
    tagIds: [],
    pan: "",
    tdsSection: "",
  });
  return { id: made.id, name: made.name };
}

/**
 * The good rows made in the file's order: the vendor added when new (once), the bill through createBill, and its
 * payment through recordBillPayment when it was paid. A row that fails does not stop the rest; a payment that fails
 * leaves the bill made, unpaid, and says so.
 */
export async function importBills(orgId: string, userId: string, input: BillImportInput, who: BillImportWho): Promise<ImportResult> {
  const [ctx, book] = await Promise.all([loadImportContext(orgId), loadVendors(orgId)]);
  const batchId = input.batchId ?? newImportBatchId();
  const checked = input.rows.map((r) => checkRow(ctx, book, r, input.dateFormat, who.canAddVendors));
  const existing = await existingFor(orgId, checked.flatMap((c) => (c.ok ? [c.v] : [])));
  const added = new Map<string, { id: string; name: string }>();
  const results: ImportResultRow[] = [];
  for (const c of checked) {
    if (!c.ok) {
      results.push({ row: c.row, status: "error", message: c.message });
      continue;
    }
    const v = c.v;
    const me = seenOf(v);
    const dup = existing.find((e) => same(e, me));
    if (dup) {
      results.push({ row: v.row, status: "duplicate", message: duplicateMessage(dup), ...(dup.id ? { id: dup.id } : {}), ...(dup.number ? { number: dup.number } : {}) });
      continue;
    }
    let vendorId = v.vendor.id ?? added.get(v.vendor.key)?.id;
    if (!vendorId) {
      try {
        const nv = await addVendor(orgId, v);
        added.set(v.vendor.key, nv);
        vendorId = nv.id;
      } catch (err) {
        results.push({ row: v.row, status: "error", message: `Vendor '${v.vendor.name}' could not be added: ${(err as Error).message}` });
        continue;
      }
    }
    let made: Awaited<ReturnType<typeof createBill>>;
    try {
      const bill: CreateBillInput = {
        vendorId,
        billDate: v.billDate,
        dueDate: v.dueDate,
        currency: v.currency,
        lineItems: [{ description: v.description, quantity: 1, unitPriceMinor: v.amountMinor, discountPct: 0, taxPct: v.taxPct }],
        notes: v.notes,
        paymentTerms: v.paymentTerms,
        requiresApproval: false,
        category: v.category,
        ...(v.subcategory ? { subcategory: v.subcategory } : {}),
      };
      // No late actor: imported bills are history (the user's choice, 2026-11-11); who imported it is still kept.
      made = await createBill(orgId, bill, undefined, { createdById: userId, reference: v.billNumber, importBatchId: batchId });
    } catch (err) {
      results.push({ row: v.row, status: "error", message: (err as Error).message || "Could not be created" });
      continue;
    }
    existing.push({ ...me, vendorId, id: made.id, number: made.billNumber });
    let warning: string | undefined;
    if (v.payment) {
      try {
        await recordBillPayment(orgId, made.id, {
          method: v.payment.method,
          // What the vendor is owed — the total less any TDS (Bangalore, 2026-11-11).
          amountMinor: made.balanceMinor,
          paidOn: v.payment.paidOn,
          reference: v.billNumber,
          accountName: "",
          bankAccountId: v.payment.account.id,
          notes: "",
          chargesMinor: 0,
        }, undefined);
      } catch (err) {
        warning = `Made, but its payment could not be recorded: ${(err as Error).message} — record it on the bill`;
      }
    }
    results.push({ row: v.row, status: "created", id: made.id, number: made.billNumber, ...(warning ? { warning } : {}) });
  }
  const counts = {
    created: results.filter((r) => r.status === "created").length,
    duplicate: results.filter((r) => r.status === "duplicate").length,
    error: results.filter((r) => r.status === "error").length,
  };
  logger.info({ orgId, userId, batchId, fileName: input.fileName, rows: input.rows.length, vendorsAdded: added.size, ...counts }, "Bills imported from a spreadsheet");
  return { batchId, rows: results, counts, newVendors: [...added.values()] };
}
