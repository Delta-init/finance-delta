/**
 * The stored-total correction (base-total-backfill.ts, 2026-11-27) against a scratch database: invoices whose stored
 * total in the organization's currency fell behind an edit are found and only that figure is put right; the look
 * writes nothing; --write needs the code the look printed and refuses a stale one; an invoice changed after the look
 * stops the run; a second run finds nothing; undo puts each back, but not one changed since.
 *
 * Run through scripts/base-total-backfill-e2e.sh. Scratch database only.
 */
import { existsSync, rmSync } from "node:fs";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri) || /:27017\//.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1 (not 27017), got "${uri}"`);
  process.exit(1);
}

const { Invoice } = await import("../modules/invoice/invoice.model");
const { Organization } = await import("../modules/organization/organization.model");
const { backfillBaseTotals, findStaleBaseTotals, undoBaseTotals } = await import("./base-total-backfill");
const mongoose = (Invoice as any).base;
await mongoose.connect(uri);

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}

const undoFiles: string[] = [];
try {
  await mongoose.connection.dropDatabase();
  const now = new Date();
  const org = await Organization.collection.insertOne({ name: "Dubai Org", baseCurrency: "AED", currency: "AED", createdAt: now, updatedAt: now });
  const O = org.insertedId;
  const make = (n: string, total: number, base: number, extra: Record<string, unknown> = {}) => ({
    organizationId: O, invoiceNumber: n, customerName: "Client", status: "paid", currency: "AED", issueDate: now,
    totalMinor: total, baseTotalMinor: base, exchangeRate: 1, amountPaidMinor: total, balanceMinor: 0, taxTotalMinor: 1234, payments: [], ...extra,
  });
  await Invoice.collection.insertMany([
    make("IN-1", 550_000, 225_000),                                  // course changed up: shown 2,250, really 5,500
    make("IN-2", 150_000, 1_500_000),                                // edited down: shown 15,000, really 1,500
    make("IN-3", 225_000, 225_000),                                  // in step
    make("IN-4", 100_000, 0),                                        // never stored
    make("IN-5", 1_000_000, 1_000_000, { currency: "USD", exchangeRate: 0.2722 }), // another currency, out of step
    make("IN-6", 999_900, 1, { status: "void" }),                     // void: left alone
  ]);

  console.log("\n\x1b[1mThe look\x1b[0m");
  let look = await backfillBaseTotals({ write: false });
  const byNo = Object.fromEntries(look.rows.map((r) => [r.invoice, r]));
  check("finds exactly the four out of step, not the one in step or the void one", JSON.stringify(look.rows.map((r) => r.invoice).sort()) === JSON.stringify(["IN-1", "IN-2", "IN-4", "IN-5"]), JSON.stringify(look.rows.map((r) => r.invoice)));
  check("IN-1: 2,250 → 5,500", byNo["IN-1"]?.storedMinor === 225_000 && byNo["IN-1"]?.shouldBeMinor === 550_000, JSON.stringify(byNo["IN-1"]));
  check("IN-2: 15,000 → 1,500", byNo["IN-2"]?.shouldBeMinor === 150_000);
  check("IN-5: worked out as when an invoice is made (total ÷ rate)", byNo["IN-5"]?.shouldBeMinor === Math.round(1_000_000 / 0.2722), JSON.stringify(byNo["IN-5"]));
  check("the look writes nothing", (await Invoice.collection.findOne({ invoiceNumber: "IN-1" }))?.baseTotalMinor === 225_000 && look.written === 0);

  console.log("\n\x1b[1mWriting\x1b[0m");
  let threw = "";
  try { await backfillBaseTotals({ write: true }); } catch (e) { threw = (e as Error).message; }
  check("--write without the code is refused", /is not what there is now/.test(threw), threw);
  threw = "";
  try { await backfillBaseTotals({ write: true, expect: "00000000" }); } catch (e) { threw = (e as Error).message; }
  check("…and with a wrong one", /is not what there is now/.test(threw), threw);
  check("…and nothing was written", (await Invoice.collection.findOne({ invoiceNumber: "IN-1" }))?.baseTotalMinor === 225_000);

  // Changed between the look and the write: the code no longer matches.
  await Invoice.collection.updateOne({ invoiceNumber: "IN-4" }, { $set: { totalMinor: 120_000 } });
  threw = "";
  try { await backfillBaseTotals({ write: true, expect: look.code }); } catch (e) { threw = (e as Error).message; }
  check("an invoice changed after the look: the old code is refused", /is not what there is now/.test(threw), threw);
  await Invoice.collection.updateOne({ invoiceNumber: "IN-4" }, { $set: { totalMinor: 100_000 } });

  const before = await Invoice.collection.findOne({ invoiceNumber: "IN-1" });
  const res = await backfillBaseTotals({ write: true, expect: look.code });
  if (res.undoFile) undoFiles.push(res.undoFile);
  const after = Object.fromEntries((await Invoice.collection.find({}).toArray()).map((d: any) => [d.invoiceNumber, d]));
  check("four written, an undo file kept", res.written === 4 && !!res.undoFile && existsSync(res.undoFile), JSON.stringify({ w: res.written, f: res.undoFile }));
  check("each stored total is now its total", after["IN-1"].baseTotalMinor === 550_000 && after["IN-2"].baseTotalMinor === 150_000 && after["IN-4"].baseTotalMinor === 100_000
    && after["IN-5"].baseTotalMinor === Math.round(1_000_000 / 0.2722), JSON.stringify(Object.values(after).map((d: any) => [d.invoiceNumber, d.baseTotalMinor])));
  check("nothing else touched: total, paid, balance, tax, status, payments", ["totalMinor", "amountPaidMinor", "balanceMinor", "taxTotalMinor", "status", "currency", "exchangeRate"]
    .every((k) => JSON.stringify((after["IN-1"] as any)[k]) === JSON.stringify((before as any)[k])), JSON.stringify(after["IN-1"]));
  check("the in-step and void invoices are as they were", after["IN-3"].baseTotalMinor === 225_000 && after["IN-6"].baseTotalMinor === 1);
  check("a second look finds nothing", (await findStaleBaseTotals()).length === 0);

  console.log("\n\x1b[1mUndo\x1b[0m");
  await Invoice.collection.updateOne({ invoiceNumber: "IN-2" }, { $set: { baseTotalMinor: 160_000, totalMinor: 160_000 } }); // edited since
  const undone = await undoBaseTotals(res.undoFile!);
  const back = Object.fromEntries((await Invoice.collection.find({}).toArray()).map((d: any) => [d.invoiceNumber, d]));
  check("undo puts back the three still as written", undone.restored === 3 && back["IN-1"].baseTotalMinor === 225_000 && back["IN-4"].baseTotalMinor === 0 && back["IN-5"].baseTotalMinor === 1_000_000,
    JSON.stringify(undone));
  check("…and leaves alone the one edited since", JSON.stringify(undone.skipped) === JSON.stringify(["IN-2"]) && back["IN-2"].baseTotalMinor === 160_000, JSON.stringify(undone));

  // A run that stops part-way: an invoice changed under it.
  look = await backfillBaseTotals({ write: false });
  const realUpdate = Invoice.collection.updateOne.bind(Invoice.collection);
  let calls = 0;
  (Invoice.collection as any).updateOne = async (f: any, u: any) => {
    if (++calls === 2) await realUpdate({ _id: f._id }, { $set: { totalMinor: 777_700 } });
    return realUpdate(f, u);
  };
  threw = "";
  let stopped: string | undefined;
  try { await backfillBaseTotals({ write: true, expect: look.code, undoFile: `base-total-backfill-undo-e2e-${Date.now()}.json` }); } catch (e) { threw = (e as Error).message; stopped = threw.match(/are in (\S+)$/)?.[1]; }
  (Invoice.collection as any).updateOne = realUpdate;
  if (stopped) undoFiles.push(stopped);
  check("an invoice changed while it runs: it stops there, saying how many were done", /changed while this ran — nothing more was written; 1 done/.test(threw), threw);
} finally {
  for (const f of undoFiles) if (existsSync(f)) rmSync(f);
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
