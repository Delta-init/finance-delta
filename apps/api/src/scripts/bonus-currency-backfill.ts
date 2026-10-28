/**
 * A sales CRM's bonus with no currency is a US-dollar bonus (the user, 2026-10-12).
 *
 * Since 2026-10-09 every sales CRM sends the close's bonus as USD. Closes
 * queued before the CRM servers had that change carry no currency, and finance
 * stored none — then showed and passed the bonus on in the INVOICE's currency
 * (an "AED 500" bonus that was $500). The amounts were always meant as US
 * dollars: nothing is converted, only the label is set.
 *
 * This labels them: `enrolment.bonus.currency = "USD"` on every invoice a sales
 * CRM sold (enrolment.crm, or external.source crm / draw-crm / banglore-crm)
 * whose bonus was given and carries no currency. An enrolment typed in finance
 * (no CRM) is never touched — its bonus stays in the invoice's currency. The
 * LMS provisioning record's snapshot (payload.feeSummary.bonus.currency) of
 * those invoices is relabelled too, so a retry passes on USD.
 *
 * What CS Portal and the LMS were already told is not re-sent — finance
 * has no message that carries the bonus after approval. Their own scripts fix
 * it there (CS Portal backend/src/scripts/bonus-currency-backfill.ts,
 * LMS backend/src/scripts/bonus-currency-backfill.ts), from the list this
 * writes: every sales-CRM invoice whose bonus is USD.
 *
 * Reads and prints only, unless --write. Before writing it saves an undo file.
 * Safe to run again: a bonus already labelled is left alone. Run from apps/api
 * on the server (Bun reads MONGODB_URI from the .env there):
 *
 *   cd apps/api
 *   bun src/scripts/bonus-currency-backfill.ts                 # what it would do
 *   bun src/scripts/bonus-currency-backfill.ts --write         # do it
 *   bun src/scripts/bonus-currency-backfill.ts --undo backups/bonus-currency/undo-<time>.json
 *
 *   --out <dir>   where the undo file and the invoice list go (default ./backups/bonus-currency)
 *   --amount IN-00098=500   also correct that bonus's amount, in US dollars (repeatable): a close
 *                 whose salesperson typed the AED equivalent (the user, 2026-10-12: IN-00098's
 *                 1,836.50 was $500). Only one being labelled here; the list carries it to the
 *                 CS Portal and LMS scripts, which correct it there too.
 *   --uri <uri>   the database, instead of MONGODB_URI
 */
import fs from "node:fs";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { CRM_BONUS_CURRENCY, enrolmentCrm, formatMoney } from "@delta/shared";

type Coll = mongoose.mongo.Collection;

/** A collection that can only be read — what a dry run is given, so it cannot write by mistake. */
export function readOnly(c: Coll): Coll {
  const allowed = new Set(["find", "findOne", "countDocuments", "collectionName"]);
  return new Proxy(c, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !allowed.has(prop)) throw new Error(`Dry run: ${prop} is not allowed on ${target.collectionName}`);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const blank = (v: unknown) => v === undefined || v === null || v === "";

export interface BackfillRow {
  invoiceId: string;
  invoiceNumber: string;
  crm: string;
  status: string;
  approval: string;
  bonus: string;
  /** The bonus's amount as stored, and the one it is corrected to (--amount), minor units. */
  amountMinor: number;
  newAmountMinor?: number;
  /** What finance showed it as: the invoice's currency. */
  shownAs: string;
  /** The LMS provisioning record: its state, whether the student went to CS Portal, and its snapshot's label. */
  provision: string;
}

export interface BackfillResult {
  rows: BackfillRow[];
  /** Every sales-CRM invoice with a bonus given that is (or now will be) USD — for the CS Portal and LMS scripts. */
  usdInvoices: { invoiceId: string; invoiceNumber: string; crm: string; amountMinor?: number }[];
  provisionsToFix: { _id: string; invoiceId: string; before: unknown; amountBefore?: unknown; newAmountMinor?: number }[];
  /** Bonuses typed in finance with no currency: left alone. */
  typedLeftAlone: number;
}

/** "IN-00098=500" → { "IN-00098": 50000 }; throws on anything else. */
export function parseAmounts(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9-]+)=(\d+(?:\.\d{1,2})?)$/.exec(v);
    if (!m || !(Number(m[2]) > 0)) throw new Error(`--amount ${v}: expected INVOICE=dollars, e.g. IN-00098=500`);
    out[m[1]!.toUpperCase()] = Math.round(Number(m[2]) * 100);
  }
  return out;
}

export async function planBonusCurrency(db: { invoices: Coll; provisions: Coll }, amounts: Record<string, number> = {}): Promise<BackfillResult> {
  const given = await db.invoices
    .find({ "enrolment.bonus.given": true, "enrolment.bonus.amountMinor": { $gt: 0 } })
    .project({ invoiceNumber: 1, currency: 1, status: 1, "approval.state": 1, external: 1, "enrolment.crm": 1, "enrolment.bonus": 1 })
    .sort({ issueDate: 1, _id: 1 })
    .toArray();

  const usdInvoices: BackfillResult["usdInvoices"] = [];
  const targets: typeof given = [];
  let typedLeftAlone = 0;
  for (const i of given) {
    const crm = enrolmentCrm(i.enrolment?.crm, i.external?.source);
    const own = String(i.enrolment?.bonus?.currency ?? "").trim().toUpperCase();
    if (!crm) {
      if (!own) typedLeftAlone++;
      continue;
    }
    if (!own) targets.push(i);
    const fix = !own ? amounts[String(i.invoiceNumber ?? "").toUpperCase()] : undefined;
    if (!own || own === CRM_BONUS_CURRENCY) usdInvoices.push({ invoiceId: String(i._id), invoiceNumber: String(i.invoiceNumber ?? ""), crm, ...(fix ? { amountMinor: fix } : {}) });
  }
  // An amount for an invoice this does not label is a mistake, not something to skip quietly.
  const labelled = new Set(targets.map((t) => String(t.invoiceNumber ?? "").toUpperCase()));
  const stray = Object.keys(amounts).filter((n) => !labelled.has(n));
  if (stray.length) throw new Error(`--amount: ${stray.join(", ")} is not a sales-CRM bonus with no currency — nothing to correct`);
  const newAmountOf = new Map(usdInvoices.filter((u) => u.amountMinor).map((u) => [u.invoiceId, u.amountMinor!]));

  const ids = usdInvoices.map((u) => new Types.ObjectId(u.invoiceId));
  const provisions = ids.length
    ? await db.provisions
      .find({ invoiceId: { $in: ids } })
      .project({ invoiceId: 1, status: 1, "commission.state": 1, "payload.feeSummary.bonus": 1 })
      .toArray()
    : [];
  const provisionOf = new Map(provisions.map((p) => [String(p.invoiceId), p]));
  const provisionsToFix = provisions
    .filter((p) => p.payload?.feeSummary?.bonus?.given === true
      && (String(p.payload.feeSummary.bonus.currency ?? "").toUpperCase() !== CRM_BONUS_CURRENCY || newAmountOf.has(String(p.invoiceId))))
    .map((p) => {
      const fix = newAmountOf.get(String(p.invoiceId));
      return { _id: String(p._id), invoiceId: String(p.invoiceId), before: p.payload.feeSummary.bonus.currency, ...(fix ? { amountBefore: p.payload.feeSummary.bonus.amountMinor, newAmountMinor: fix } : {}) };
    });

  const rows = targets.map((i): BackfillRow => {
    const p = provisionOf.get(String(i._id));
    return {
      invoiceId: String(i._id),
      invoiceNumber: String(i.invoiceNumber ?? ""),
      crm: enrolmentCrm(i.enrolment?.crm, i.external?.source) ?? "",
      status: String(i.status ?? ""),
      approval: String(i.approval?.state ?? ""),
      bonus: formatMoney(newAmountOf.get(String(i._id)) ?? i.enrolment.bonus.amountMinor, CRM_BONUS_CURRENCY),
      amountMinor: Number(i.enrolment.bonus.amountMinor) || 0,
      ...(newAmountOf.has(String(i._id)) ? { newAmountMinor: newAmountOf.get(String(i._id)) } : {}),
      shownAs: formatMoney(i.enrolment.bonus.amountMinor, i.currency ?? "AED"),
      provision: p
        ? `${p.status}${p.commission?.state ? `, TC ${p.commission.state}` : ""}${p.payload?.feeSummary?.bonus ? `, sent as ${p.payload.feeSummary.bonus.currency ?? "—"}` : ""}`
        : "none",
    };
  });
  return { rows, usdInvoices, provisionsToFix, typedLeftAlone };
}

/** Labels them USD — the undo file must already be written. How many invoices and provisions changed. */
export async function applyBonusCurrency(db: { invoices: Coll; provisions: Coll }, plan: BackfillResult): Promise<{ invoices: number; provisions: number }> {
  let invoices = 0;
  let provisions = 0;
  for (const r of plan.rows) {
    // Only while it still has none — never over a currency somebody set meanwhile.
    const res = await db.invoices.updateOne(
      { _id: new Types.ObjectId(r.invoiceId), "enrolment.bonus.given": true, "enrolment.bonus.currency": { $in: [null, ""] } },
      { $set: { "enrolment.bonus.currency": CRM_BONUS_CURRENCY, ...(r.newAmountMinor ? { "enrolment.bonus.amountMinor": r.newAmountMinor } : {}) } },
    );
    invoices += res.modifiedCount;
  }
  for (const p of plan.provisionsToFix) {
    const res = await db.provisions.updateOne(
      { _id: new Types.ObjectId(p._id), "payload.feeSummary.bonus.given": true },
      { $set: { "payload.feeSummary.bonus.currency": CRM_BONUS_CURRENCY, ...(p.newAmountMinor ? { "payload.feeSummary.bonus.amountMinor": p.newAmountMinor } : {}) } },
    );
    provisions += res.modifiedCount;
  }
  return { invoices, provisions };
}

export interface UndoFile {
  kind: "finance-bonus-currency";
  at: string;
  invoices: { _id: string; invoiceNumber: string; before: unknown; amountBefore?: number }[];
  provisions: { _id: string; invoiceId: string; before: unknown; amountBefore?: unknown }[];
}

export function undoOf(plan: BackfillResult, at = new Date()): UndoFile {
  return {
    kind: "finance-bonus-currency",
    at: at.toISOString(),
    invoices: plan.rows.map((r) => ({ _id: r.invoiceId, invoiceNumber: r.invoiceNumber, before: null, ...(r.newAmountMinor ? { amountBefore: r.amountMinor } : {}) })),
    provisions: plan.provisionsToFix,
  };
}

/** Puts back what the undo file recorded — only where the label is still the USD this set. */
export async function undoBonusCurrency(db: { invoices: Coll; provisions: Coll }, undo: UndoFile): Promise<{ invoices: number; provisions: number }> {
  if (undo.kind !== "finance-bonus-currency") throw new Error("Not a finance bonus-currency undo file");
  let invoices = 0;
  let provisions = 0;
  for (const i of undo.invoices) {
    const res = await db.invoices.updateOne(
      { _id: new Types.ObjectId(i._id), "enrolment.bonus.currency": CRM_BONUS_CURRENCY },
      {
        ...(blank(i.before) ? { $unset: { "enrolment.bonus.currency": "" } } : { $set: { "enrolment.bonus.currency": i.before } }),
        ...(typeof i.amountBefore === "number" && blank(i.before) ? { $set: { "enrolment.bonus.amountMinor": i.amountBefore } } : {}),
      },
    );
    invoices += res.modifiedCount;
  }
  for (const p of undo.provisions) {
    const res = await db.provisions.updateOne(
      { _id: new Types.ObjectId(p._id), "payload.feeSummary.bonus.currency": CRM_BONUS_CURRENCY },
      {
        ...(p.before === undefined ? { $unset: { "payload.feeSummary.bonus.currency": "" } } : {}),
        ...(p.before !== undefined || typeof p.amountBefore === "number"
          ? { $set: { ...(p.before !== undefined ? { "payload.feeSummary.bonus.currency": p.before } : {}), ...(typeof p.amountBefore === "number" ? { "payload.feeSummary.bonus.amountMinor": p.amountBefore } : {}) } }
          : {}),
      },
    );
    provisions += res.modifiedCount;
  }
  return { invoices, provisions };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const amounts = parseAmounts(process.argv.flatMap((a, i) => (a === "--amount" ? [process.argv[i + 1] ?? ""] : [])));
  const undoPath = arg("--undo");
  const outDir = path.resolve(arg("--out") ?? "backups/bonus-currency");
  const uri = arg("--uri") ?? process.env.MONGODB_URI ?? "";
  if (!uri) {
    console.error("No database: set MONGODB_URI or pass --uri");
    process.exit(1);
  }
  const mutating = write || Boolean(undoPath);
  // No models, so nothing is indexed or created on connecting.
  const conn = await mongoose.createConnection(uri, { autoIndex: false, autoCreate: false }).asPromise();
  const raw = { invoices: conn.db!.collection("invoices"), provisions: conn.db!.collection("lmsprovisions") };
  const db = mutating ? raw : { invoices: readOnly(raw.invoices), provisions: readOnly(raw.provisions) };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    if (undoPath) {
      const undo = JSON.parse(fs.readFileSync(undoPath, "utf8")) as UndoFile;
      const done = await undoBonusCurrency(db, undo);
      console.log(`Undone: ${done.invoices} invoice bonus label(s), ${done.provisions} LMS provisioning snapshot(s) put back.`);
    } else {
      const plan = await planBonusCurrency(db, amounts);
      console.log(`Database: ${conn.db!.databaseName}${write ? "" : "  (dry run — read only)"}\n`);
      console.log(["Invoice".padEnd(13), "CRM".padEnd(9), "Status".padEnd(8), "Approval".padEnd(9), "Bonus".padEnd(12), "Was shown as".padEnd(14), "LMS provisioning"].join(" "));
      for (const r of plan.rows) {
        console.log([r.invoiceNumber.padEnd(13), r.crm.padEnd(9), r.status.padEnd(8), r.approval.padEnd(9), r.bonus.padEnd(12), r.shownAs.padEnd(14), r.provision].join(" ")
          + (r.newAmountMinor ? `   ← amount corrected from ${formatMoney(r.amountMinor, CRM_BONUS_CURRENCY)}` : ""));
      }
      const byCrm = plan.rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.crm]: (a[r.crm] ?? 0) + 1 }), {});
      console.log(`\n${plan.rows.length} sales-CRM bonus(es) with no currency ${write ? "to label" : "would be labelled"} USD — ${Object.entries(byCrm).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
      console.log(`${plan.provisionsToFix.length} LMS provisioning snapshot(s) ${write ? "to relabel" : "would be relabelled"} USD`);
      console.log(`${plan.typedLeftAlone} bonus(es) typed in finance with no currency — left alone (the invoice's currency)`);
      console.log(`${plan.usdInvoices.length} sales-CRM invoice(s) with a USD bonus in all, once done`);

      fs.mkdirSync(outDir, { recursive: true });
      const listPath = path.join(outDir, `crm-usd-bonus-invoices-${stamp}.json`);
      fs.writeFileSync(listPath, JSON.stringify({ kind: "crm-usd-bonus-invoices", at: new Date().toISOString(), invoices: plan.usdInvoices }, null, 2));
      console.log(`\nInvoice list for the CS Portal and LMS scripts: ${listPath}`);

      if (write) {
        if (plan.rows.length || plan.provisionsToFix.length) {
          const undoFile = path.join(outDir, `undo-${stamp}.json`);
          fs.writeFileSync(undoFile, JSON.stringify(undoOf(plan), null, 2));
          console.log(`Undo file: ${undoFile}`);
          const done = await applyBonusCurrency(db, plan);
          console.log(`Done: ${done.invoices} invoice bonus(es) and ${done.provisions} LMS provisioning snapshot(s) labelled USD.`);
        } else {
          console.log("Nothing to change.");
        }
      } else {
        console.log("Nothing written to the database. Run again with --write to do it.");
      }
    }
  } finally {
    await conn.close();
  }
}
