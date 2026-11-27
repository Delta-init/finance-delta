/**
 * An invoice's stored total in the organization's currency (`baseTotalMinor`) was set when the invoice was made and
 * never again (2026-11-27): an invoice edited afterwards — a course change, its lines changed in finance — kept its
 * old figure, and the Revenue report, which reads it first, showed the old amount (a course changed from AED 2,250 to
 * AED 5,500 still showed 2,250). Editing keeps it in step now (invoice.service updateInvoice); this puts right the
 * invoices edited before that.
 *
 * For every invoice that is not void: what it should be is worked out exactly as when an invoice is made —
 * toBaseMinor(totalMinor, exchangeRate) — and an invoice whose stored figure differs is listed, then changed. Only
 * that one figure: no total, payment, tax or status is touched. Nobody is emailed.
 *
 * Reads and prints only, unless --write; --write saves an undo file first and adds to it as it goes. Run it from
 * apps/api on the server:
 *
 *   bun src/scripts/base-total-backfill.ts                           # what it would do
 *   bun src/scripts/base-total-backfill.ts --write --expect <code>   # <code> as the look printed it
 *   bun src/scripts/base-total-backfill.ts --undo <file>
 */
import mongoose from "mongoose";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { formatMoney, toBaseMinor } from "@delta/shared";

export interface BaseTotalRow {
  id: string; invoice: string; organization: string; currency: string; baseCurrency: string;
  totalMinor: number; rate: number; storedMinor: number; shouldBeMinor: number;
  /** Nothing stored at all (the field missing or null) — listed as 0, but never equal to 0 in a query. */
  storedMissing: boolean;
}

const EJSON = () => mongoose.mongo.BSON.EJSON;

/** Every invoice whose stored base total is not what its total and rate make it, oldest first. */
export async function findStaleBaseTotals(): Promise<BaseTotalRow[]> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { Organization } = await import("../modules/organization/organization.model");
  const orgs = new Map((await Organization.find({}).select("name baseCurrency currency").lean<any[]>()).map((o) => [String(o._id), o]));
  const docs = await Invoice.collection.find({ status: { $ne: "void" } })
    .project({ organizationId: 1, invoiceNumber: 1, currency: 1, totalMinor: 1, exchangeRate: 1, baseTotalMinor: 1, issueDate: 1 })
    .sort({ issueDate: 1, invoiceNumber: 1 }).toArray();
  const rows: BaseTotalRow[] = [];
  for (const d of docs as any[]) {
    const rate = Number(d.exchangeRate) || 1;
    const total = Number(d.totalMinor) || 0;
    const shouldBe = toBaseMinor(total, rate);
    const storedMissing = d.baseTotalMinor === undefined || d.baseTotalMinor === null;
    const stored = Number(d.baseTotalMinor) || 0;
    if (!storedMissing && stored === shouldBe) continue;
    const org = orgs.get(String(d.organizationId));
    rows.push({
      id: String(d._id), invoice: String(d.invoiceNumber), organization: String(org?.name ?? d.organizationId),
      currency: String(d.currency ?? "AED"), baseCurrency: String(org?.baseCurrency ?? org?.currency ?? d.currency ?? "AED"),
      totalMinor: total, rate, storedMinor: stored, shouldBeMinor: shouldBe, storedMissing,
    });
  }
  return rows;
}

/** A short code for exactly these changes, so --write changes what was looked at and nothing else. */
const codeOf = (rows: BaseTotalRow[]) =>
  createHash("sha256").update(rows.map((r) => `${r.id}:${r.storedMissing ? "none" : r.storedMinor}>${r.shouldBeMinor}`).join("|")).digest("hex").slice(0, 8);

export async function backfillBaseTotals(o: { write: boolean; expect?: string; undoFile?: string }): Promise<{ rows: BaseTotalRow[]; code: string; written: number; undoFile?: string }> {
  const rows = await findStaleBaseTotals();
  const code = codeOf(rows);
  if (!o.write || !rows.length) return { rows, code, written: 0 };
  if (o.expect !== code) throw new Error(`--expect ${o.expect ?? "(none)"} is not what there is now (${code}) — look again before writing`);

  const { Invoice } = await import("../modules/invoice/invoice.model");
  const undoFile = o.undoFile ?? `base-total-backfill-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const done: Array<{ id: string; invoice: string; before: number; after: number; missing?: boolean }> = [];
  const save = () => writeFileSync(undoFile, EJSON().stringify({ invoices: done }, undefined, 2, { relaxed: false }));
  save();
  for (const r of rows) {
    // Only if the invoice is still as it was looked at: same total, same stored figure — or still none stored
    // ({ $in: [null] } matches a field that is missing as well as one that is null; it found 2026-11-27 that a plain
    // 0 matches neither, and stopped the first run at the first invoice with nothing stored).
    const res = await Invoice.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(r.id), totalMinor: r.totalMinor, baseTotalMinor: r.storedMissing ? { $in: [null] } : r.storedMinor },
      { $set: { baseTotalMinor: r.shouldBeMinor } },
    );
    if (!res.matchedCount) throw new Error(`Invoice ${r.invoice} changed while this ran — nothing more was written; ${done.length} done so far are in ${undoFile}`);
    done.push({ id: r.id, invoice: r.invoice, before: r.storedMinor, after: r.shouldBeMinor, ...(r.storedMissing ? { missing: true } : {}) });
    save();
  }
  return { rows, code, written: done.length, undoFile };
}

/** Puts back what a --write changed, from its undo file — each invoice only if it still has the figure written. */
export async function undoBaseTotals(file: string): Promise<{ restored: number; skipped: string[] }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { invoices } = EJSON().parse(readFileSync(file, "utf8"), { relaxed: false }) as { invoices: Array<{ id: string; invoice: string; before: number; after: number; missing?: boolean }> };
  let restored = 0;
  const skipped: string[] = [];
  for (const r of [...invoices].reverse()) {
    // One that had nothing stored goes back to nothing stored.
    const res = await Invoice.collection.updateOne({ _id: new mongoose.Types.ObjectId(r.id), baseTotalMinor: r.after }, r.missing ? { $unset: { baseTotalMinor: "" } } : { $set: { baseTotalMinor: r.before } });
    if (res.matchedCount) restored++; else skipped.push(r.invoice);
  }
  return { restored, skipped };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    const undo = arg("--undo");
    if (undo) {
      const { restored, skipped } = await undoBaseTotals(undo);
      console.log(`${restored} invoice(s) put back as they were, from ${undo}${skipped.length ? `; left alone (changed since): ${skipped.join(", ")}` : ""}`);
    } else {
      const write = args.includes("--write");
      const { rows, code, written, undoFile } = await backfillBaseTotals({ write, expect: arg("--expect") });
      for (const r of rows) {
        const rate = r.rate !== 1 ? `  (total ${formatMoney(r.totalMinor, r.currency)} at rate ${r.rate})` : "";
        console.log(`${r.invoice.padEnd(12)} ${r.organization.padEnd(32)} ${r.storedMissing ? "nothing stored" : formatMoney(r.storedMinor, r.baseCurrency)} → ${formatMoney(r.shouldBeMinor, r.baseCurrency)}${rate}`);
      }
      console.log(`\n${rows.length} invoice(s) with a stored total out of step: ${write ? `${written} changed` : "would change"}. Only that figure; nothing else is touched and nobody is emailed.`);
      if (!write && rows.length) console.log(`To write:  bun src/scripts/base-total-backfill.ts --write --expect ${code}`);
      if (undoFile) console.log(`Undo file: ${undoFile}  (bun src/scripts/base-total-backfill.ts --undo ${undoFile})`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
