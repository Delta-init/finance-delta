/**
 * Exports read every page under the table's filters (the user, 2026-10-18: "the export needs the filters working and
 * matching, but pagination shouldn't affect it") — the list services an export pages through, on a scratch database,
 * with more rows than one page:
 *   1. A sort on a shared value (250 vendors, one status): every row once across pages — the sort ends in _id.
 *   2. Inventory "Low stock" (250 items, every third low): found before paging — the total, every low item once.
 *   3. Credit notes paged, filtered by status and searched (230): every match once; unpaged, the newest 200 as before.
 *   4. Payments (240 across 3 invoices) from a date: every one in the range once, page by page as the export reads it.
 * Run through scripts/export-paging-e2e.sh. Scratch databases only.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const { listVendors } = await import("../modules/vendor/vendor.service");
const { listItems } = await import("../modules/inventory/inventory.service");
const { listCreditNotes, listCreditNotesPaged } = await import("../modules/credit-note/credit-note.service");
const { listPayments } = await import("../modules/invoice/payment.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const org = new Types.ObjectId();
const ORG = String(org);
const when = new Date("2026-10-01T08:00:00Z");

/** Every page, as an export reads them (100 a page, until the last). */
async function everyPage<T extends { id: string }>(read: (page: number) => Promise<{ data: T[]; pageCount: number }>) {
  const rows: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await read(page);
    rows.push(...r.data);
    if (page >= r.pageCount || !r.data.length) break;
  }
  return rows;
}
const once = (ids: string[]) => new Set(ids).size === ids.length;

/* ── 1 ── */
step("1. A sort on a shared value: every row once");
await db.collection("vendors").insertMany(Array.from({ length: 250 }, (_, i) => ({
  organizationId: org, vendorCode: `VEN-${String(i).padStart(5, "0")}`, name: "Same Name", email: `v${i}@e2e.test`, phone: "+971400000000",
  status: "active", currency: "AED", createdAt: when, updatedAt: when,
})));
for (const sort of ["status", "name", "createdAt"]) {
  const rows = await everyPage(async (page) => {
    const r = await listVendors(ORG, { page, pageSize: 100, sort, dir: "asc" } as never);
    return { data: r.data, pageCount: r.meta.pageCount };
  });
  check(`sorted by ${sort} (all the same): 250 rows, none twice`, rows.length === 250 && once(rows.map((r) => r.id)), `${rows.length} rows, ${new Set(rows.map((r) => r.id)).size} different`);
}

/* ── 2 ── */
step("2. Inventory low stock: found before paging");
const items = Array.from({ length: 250 }, (_, i) => ({
  _id: new Types.ObjectId(), organizationId: org, itemNumber: `ITM-${String(i).padStart(5, "0")}`, name: `Item ${String(i).padStart(3, "0")}`,
  sku: `SKU-${i}`, type: "goods", unit: "pcs", trackStock: true, reorderPoint: 5, isActive: true, sellingPriceMinor: 100, costPriceMinor: 50,
  createdAt: when, updatedAt: when,
}));
await db.collection("items").insertMany(items);
const warehouse = new Types.ObjectId();
await db.collection("stocklevels").insertMany(items.map((it, i) => ({
  organizationId: org, itemId: it._id, warehouseId: warehouse, quantityOnHand: i % 3 === 0 ? 0 : 10,
})));
const lowWanted = items.filter((_, i) => i % 3 === 0).map((it) => String(it._id));
const first = await listItems(ORG, { page: 1, pageSize: 100, sort: "name", dir: "asc", lowStock: true } as never);
check(`the total is every low item (${lowWanted.length}), not one page's`, first.meta.total === lowWanted.length && first.meta.pageCount === 1 && first.data.length === lowWanted.length, JSON.stringify(first.meta));
const small = await everyPage(async (page) => {
  const r = await listItems(ORG, { page, pageSize: 30, sort: "name", dir: "asc", lowStock: true } as never);
  return { data: r.data, pageCount: r.meta.pageCount };
});
check("30 a page: every low item once, each low, in name order", small.length === lowWanted.length && once(small.map((r) => r.id))
  && small.every((r) => r.isLowStock) && small.map((r) => r.name).join() === [...small.map((r) => r.name)].sort().join(), `${small.length}`);
const all = await listItems(ORG, { page: 1, pageSize: 100, sort: "name", dir: "asc" } as never);
check("without the filter: every item counted", all.meta.total === 250 && all.data.length === 100);

/* ── 3 ── */
step("3. Credit notes: paged, filtered, searched");
await db.collection("creditnotes").insertMany(Array.from({ length: 230 }, (_, i) => ({
  organizationId: org, creditNoteNumber: `CN-${String(i).padStart(5, "0")}`, customerName: i % 10 === 0 ? "Zara Special" : "Client",
  invoiceNumber: `IN-${i}`, invoiceId: new Types.ObjectId(), customerId: new Types.ObjectId(), status: i % 2 ? "voided" : "issued",
  reason: "Refund", currency: "AED", lineItems: [], subtotalMinor: 1000, taxMinor: 0, totalMinor: 1000, amountAppliedMinor: 0,
  createdAt: new Date(when.getTime() + i * 1000), updatedAt: when,
})));
const issued = await everyPage(async (page) => {
  const r = await listCreditNotesPaged(ORG, { page, pageSize: 100, dir: "desc", status: "issued" } as never);
  return { data: r.data, pageCount: r.meta.pageCount };
});
check("issued only: all 115, none twice, none voided", issued.length === 115 && once(issued.map((r) => r.id)) && issued.every((r) => r.status === "issued"), `${issued.length}`);
const zara = await listCreditNotesPaged(ORG, { page: 1, pageSize: 100, dir: "desc", q: "zara" } as never);
check("searched by customer: the 23 of them", zara.meta.total === 23 && zara.data.every((r) => r.customerName === "Zara Special"), JSON.stringify(zara.meta));
const legacy = await listCreditNotes(ORG);
check("asked without a page: the newest 200, as before", legacy.length === 200 && legacy[0]?.creditNoteNumber === "CN-00229");

/* ── 4 ── */
step("4. Payments from a date: every one in the range once");
const pay = (i: number) => ({
  _id: new Types.ObjectId(), method: i % 2 ? "card" : "cash", amountMinor: 100 + i, paidOn: new Date(Date.UTC(2026, 8 + (i % 2), 1 + (i % 28))),
  reference: "", notes: "", accountName: "", chargesMinor: 0, createdAt: when,
});
let k = 0;
for (let inv = 0; inv < 3; inv++) {
  await db.collection("invoices").insertOne({
    organizationId: org, invoiceNumber: `IN-P${inv}`, customerName: `Payer ${inv}`, currency: "AED", status: "partial",
    totalMinor: 10_000_000, amountPaidMinor: 0, payments: Array.from({ length: 80 }, () => pay(k++)), createdAt: when, updatedAt: when,
  });
}
const octoberWanted = Array.from({ length: 240 }, (_, i) => i).filter((i) => i % 2 === 1).length;
const october = await everyPage(async (page) => {
  const r = await listPayments(ORG, { page, limit: 100, dateFrom: "2026-10-01", sort: "method", dir: "asc" } as never);
  return { data: r.data as unknown as { id: string }[], pageCount: r.meta.totalPages };
});
check(`from 1 October, sorted by a shared method: all ${octoberWanted}, none twice`, october.length === octoberWanted && once(october.map((r) => r.id)), `${october.length}`);
const sept = await listPayments(ORG, { page: 1, limit: 100, dateFrom: "2026-09-01", dateTo: "2026-09-30" } as never);
check("a From–To range (September): its 120 — the dates compared as dates, the last day included", sept.meta.total === 120, JSON.stringify(sept.meta));
const oneDay = await listPayments(ORG, { page: 1, limit: 100, dateFrom: "2026-09-01", dateTo: "2026-09-01" } as never);
check("…one day: that day's payments", oneDay.meta.total > 0 && oneDay.data.every((p: any) => new Date(p.paidOn).toISOString().slice(0, 10) === "2026-09-01"), JSON.stringify(oneDay.meta));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
