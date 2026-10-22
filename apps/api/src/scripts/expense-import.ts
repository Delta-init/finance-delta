/**
 * The old books' expenses brought into finance (the user, 2026-10-21: "we need to backfill this" — the export
 * Expense_2_Recategorized_17_Categories.xlsx, 6,395 rows from 2023-09 to 2026-10, each given one of the 17 categories).
 *
 * The data file is made outside the repo (it holds salaries) by root/outputs/expense-import/convert_raw.py (from the
 * raw exports, 2026-10-22 — convert.py's categorized sheet repeated a split expense's total on every line), which
 * decides each row's organization ("aed" or "inr"), category and subcategory; this script only brings the rows in:
 *
 *   - each row an expense on its own date, approved and paid, numbered HX-00001… in date order (the EXP- numbers carry
 *     on as they are), created on its own date too — so nothing reads it as entered late — and filed where the data says;
 *   - never in a bank or cash book (no bank line, no balance moves), never a late entry, never on the Approvals list,
 *     never counted on the salesperson pages against whoever ran it;
 *   - the subcategories the data adds (partner distributions, intercompany & investments — out of the P&L) added to
 *     each organization's category first;
 *   - a row that matches an expense finance already has — same organization, day and total, not voided, not imported —
 *     is skipped and listed, so nothing finance recorded itself is counted twice;
 *   - a row already imported is skipped — by its key: the old books' own id of the line ("import:<key>", 2026-10-22),
 *     else "import:<batch>:<row>" — so running it again, or with a newer export, only adds what is missing;
 *   - while expenses of another import are still in finance it writes nothing: two imports of the same books would
 *     count them twice (the first, from the categorized sheet, has to be cleared with its --undo first);
 *   - VAT as the old books had it (taxMinor of the total), and the line's reference.
 *
 * Reads and prints only, unless --write. Run it from apps/api on the server (Bun reads MONGODB_URI from the .env), after
 * the API with this change is deployed:
 *
 *   bun src/scripts/expense-import.ts --file <data.json> --org-aed <id> --org-inr <id>              # what it would do
 *   … --write --expect <N>                                                                       # do it, N as counted
 *   bun src/scripts/expense-import.ts --undo backups/expense-import-<time>.json [--write]          # take it out again
 *
 * --as <email> names who the rows are entered and approved by (default: the first super admin). Before writing, what it
 * will add is saved to backups/expense-import-<time>.json beside apps/api, and --undo removes exactly that.
 */
import fs from "node:fs";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { Organization } from "../modules/organization/organization.model";
import { User } from "../modules/user/user.model";
import { Expense } from "../modules/expense/expense.model";
import { ExpenseCategory } from "../modules/expense-category/expense-category.model";
import { ensureDefaults } from "../modules/expense-category/expense-category.service";
import { Sequence } from "../modules/sequence/sequence.model";

export interface ImportRow {
  row: number;
  org: "aed" | "inr";
  date: string;
  description: string;
  currency: string;
  totalMinor: number;
  category: string;
  subcategory: string;
  why: string;
  account: string;
  paidThrough: string;
  paymentMethod: "cash" | "bank_transfer" | null;
  needsReview: boolean;
  notes: string;
  /** The old books' own id of the line (2026-10-22): the same line in another export is the same expense. */
  key?: string;
  /** VAT inside totalMinor, and its rate. */
  taxMinor?: number;
  taxPct?: number;
  reference?: string;
}
export interface ImportData {
  batch: string;
  source: string | string[];
  subcategoriesToAdd: { category: string; slug: string; name: string; inPnl: boolean }[];
  rows: ImportRow[];
}

const SEQ_KEY = "expense_import";
const PREFIX = "HX-";
const keyOf = (batch: string, r: Pick<ImportRow, "row" | "key">) => (r.key ? `import:${r.key}` : `import:${batch}:${r.row}`);

interface OrgPlan {
  org: string;
  orgId: string;
  currency: string;
  subcategoriesToAdd: string[];
  toImport: ImportRow[];
  already: number;
  overlaps: { row: number; date: string; total: string; description: string; matches: string }[];
  repeats: number;
  /** Expenses of another import still in finance: nothing is written while there are any. */
  otherImports: number;
  problems: string[];
}
export interface ImportPlan { batch: string; orgs: OrgPlan[]; by: string; backup?: string }
export const countOf = (p: ImportPlan) => p.orgs.reduce((n, o) => n + o.subcategoriesToAdd.length + o.toImport.length, 0);

const money = (minor: number, cur: string) => `${cur} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);

function readData(file: string): ImportData {
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as ImportData;
  if (!data.batch || !/^[\w-]+$/.test(data.batch) || !Array.isArray(data.rows)) throw new Error(`${file} is not an import data file`);
  for (const r of data.rows) {
    if (!["aed", "inr"].includes(r.org) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !(Number.isInteger(r.totalMinor) && r.totalMinor > 0)
      || !r.category || !r.subcategory || !r.description) {
      throw new Error(`Row ${r.row} of ${file} is incomplete`);
    }
  }
  return data;
}

async function importer(email?: string) {
  const u = email
    ? await User.findOne({ email: email.toLowerCase() }).select("name").lean<{ _id: Types.ObjectId; name: string } | null>()
    : await User.findOne({ isSuperAdmin: true, status: "active" }).sort({ createdAt: 1 }).select("name").lean<{ _id: Types.ObjectId; name: string } | null>();
  if (!u) throw new Error(email ? `No user ${email}` : "No super admin to enter the rows as — pass --as <email>");
  return u;
}

export async function importExpenses(opts: {
  file: string; orgAed: string; orgInr: string; as?: string; write: boolean; backupDir?: string;
}): Promise<ImportPlan> {
  const data = readData(opts.file);
  const by = await importer(opts.as);
  const plan: ImportPlan = { batch: data.batch, orgs: [], by: by.name };

  for (const [code, orgId] of [["aed", opts.orgAed], ["inr", opts.orgInr]] as const) {
    const rows = data.rows.filter((r) => r.org === code);
    if (!rows.length) continue;
    if (!Types.ObjectId.isValid(orgId)) throw new Error(`--org-${code} is not an organization id`);
    const org = await Organization.findById(orgId).select("name baseCurrency").lean<{ _id: Types.ObjectId; name: string; baseCurrency?: string } | null>();
    if (!org) throw new Error(`No organization ${orgId}`);
    const p: OrgPlan = { org: org.name, orgId, currency: org.baseCurrency ?? "AED", subcategoriesToAdd: [], toImport: [], already: 0, overlaps: [], repeats: 0, otherImports: 0, problems: [] };
    plan.orgs.push(p);

    // Where they go: the organization's categories, with what the data adds.
    await ensureDefaults(orgId);
    const cats = await ExpenseCategory.find({ organizationId: org._id }).lean<any[]>();
    const subsOf = new Map(cats.map((c) => [c.slug as string, new Set(((c.subcategories ?? []) as { slug: string }[]).map((s) => s.slug))]));
    for (const add of data.subcategoriesToAdd) {
      if (!subsOf.has(add.category)) { p.problems.push(`no category "${add.category}" to add "${add.name}" to`); continue; }
      if (!subsOf.get(add.category)!.has(add.slug) && rows.some((r) => r.category === add.category && r.subcategory === add.slug)) {
        p.subcategoriesToAdd.push(`${add.category} › ${add.name}`);
        subsOf.get(add.category)!.add(add.slug);
      }
    }
    for (const r of rows) {
      if (r.currency !== p.currency) p.problems.push(`row ${r.row}: ${r.currency}, but ${org.name} keeps ${p.currency}`);
      if (!subsOf.get(r.category)?.has(r.subcategory)) p.problems.push(`row ${r.row}: ${org.name} has no ${r.category} › ${r.subcategory}`);
    }
    if (p.problems.length) continue;

    // Another import of these books still here: two would count every expense twice.
    p.otherImports = await Expense.countDocuments({ organizationId: org._id, "source.kind": "import", "source.key": { $nin: rows.map((r) => keyOf(data.batch, r)) } });
    if (p.otherImports) {
      p.problems.push(`${p.otherImports} expense(s) of another import are still here — take that import out first (its --undo), or this would count them twice`);
      continue;
    }

    // Already in: imported before, or recorded by finance itself on that day for that total.
    const imported = new Set(
      (await Expense.find({ organizationId: org._id, "source.key": { $in: rows.map((r) => keyOf(data.batch, r)) } }).select("source.key").lean<any[]>())
        .map((e) => String(e.source.key)),
    );
    const dates = rows.map((r) => r.date).sort();
    const own = await Expense.find({
      organizationId: org._id, status: { $ne: "voided" }, "source.kind": { $ne: "import" },
      expenseDate: { $gte: dayStart(dates[0]!), $lte: new Date(`${dates[dates.length - 1]}T23:59:59.999Z`) },
    }).select("expenseNumber expenseDate totalMinor description").lean<any[]>();
    const ownAt = new Map<string, any[]>();
    for (const e of own) {
      const k = `${new Date(e.expenseDate).toISOString().slice(0, 10)}|${e.totalMinor}`;
      ownAt.set(k, [...(ownAt.get(k) ?? []), e]);
    }
    const seen = new Map<string, number>();
    for (const r of rows) {
      if (imported.has(keyOf(data.batch, r))) { p.already++; continue; }
      const k = `${r.date}|${r.totalMinor}`;
      const match = ownAt.get(k);
      if (match?.length) {
        p.overlaps.push({ row: r.row, date: r.date, total: money(r.totalMinor, r.currency), description: r.description.slice(0, 60),
          matches: match.map((e) => `${e.expenseNumber} ${String(e.description ?? "").slice(0, 40)}`).join("; ") });
        continue;
      }
      const same = `${k}|${r.description}|${r.paidThrough}`;
      if (seen.has(same)) p.repeats++;
      seen.set(same, (seen.get(same) ?? 0) + 1);
      p.toImport.push(r);
    }
  }

  if (!opts.write || plan.orgs.some((o) => o.problems.length) || !countOf(plan)) return plan;

  // What is about to be added, written down whole before anything is.
  const dir = opts.backupDir ?? path.resolve(process.cwd(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `expense-import-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const backup = {
    at: new Date().toISOString(), batch: data.batch, source: data.source,
    orgs: plan.orgs.map((o) => ({ orgId: o.orgId, subcategoriesAdded: o.subcategoriesToAdd, keys: o.toImport.map((r) => keyOf(data.batch, r)) })),
  };
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  const back = JSON.parse(fs.readFileSync(file, "utf8"));
  if (back.orgs.reduce((n: number, o: { keys: string[] }) => n + o.keys.length, 0) !== plan.orgs.reduce((n, o) => n + o.toImport.length, 0)) {
    throw new Error(`The backup ${file} did not read back whole — nothing written`);
  }
  plan.backup = file;

  for (const o of plan.orgs) {
    const oid = new Types.ObjectId(o.orgId);
    for (const add of data.subcategoriesToAdd) {
      if (!o.subcategoriesToAdd.includes(`${add.category} › ${add.name}`)) continue;
      await ExpenseCategory.updateOne(
        { organizationId: oid, slug: add.category, "subcategories.slug": { $ne: add.slug } },
        { $push: { subcategories: { slug: add.slug, name: add.name, inPnl: add.inPnl } } },
      );
    }
    if (!o.toImport.length) continue;
    const cats = await ExpenseCategory.find({ organizationId: oid }).lean<any[]>();
    const names = new Map<string, { cat: string; subs: Map<string, string> }>(cats.map((c) => [c.slug, {
      cat: c.name, subs: new Map(((c.subcategories ?? []) as { slug: string; name: string }[]).map((s) => [s.slug, s.name])),
    }]));

    // A block of HX- numbers, oldest first.
    const rows = [...o.toImport].sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row);
    const seq = await Sequence.findOneAndUpdate(
      { organizationId: oid, key: SEQ_KEY },
      { $inc: { next: rows.length }, $setOnInsert: { prefix: PREFIX } },
      { upsert: true, new: true },
    );
    const first = (seq!.next as number) - rows.length + 1;

    const docs = rows.map((r, i) => {
      const at = dayStart(r.date);
      const n = names.get(r.category)!;
      const doc = new Expense({
        organizationId: oid,
        expenseNumber: `${PREFIX}${String(first + i).padStart(5, "0")}`,
        category: r.category, categoryName: n.cat,
        subcategory: r.subcategory, subcategoryName: n.subs.get(r.subcategory),
        legacyCategory: { slug: "import", name: r.account },
        description: r.description,
        expenseDate: at,
        amountMinor: r.totalMinor - (r.taxMinor ?? 0), taxPct: r.taxMinor ? r.taxPct ?? 0 : 0, taxInclusive: !!r.taxMinor,
        taxMinor: r.taxMinor ?? 0, totalMinor: r.totalMinor, reference: r.reference ?? "",
        currency: r.currency,
        paymentAccount: r.paidThrough,
        ...(r.paymentMethod ? { paymentMethod: r.paymentMethod } : {}),
        paidOn: at,
        submittedById: by._id, submittedByName: "Imported (old books)",
        status: "approved", approvedById: by._id, approvedByName: by.name, approvedAt: at,
        notes: r.notes,
        source: { kind: "import", key: keyOf(data.batch, r) },
      });
      const err = doc.validateSync();
      if (err) throw new Error(`Row ${r.row}: ${err.message}`);
      // Created on its own date: the old books entered it then, and nothing should read it as entered late today.
      return { ...doc.toObject({ depopulate: true }), createdAt: at, updatedAt: at };
    });
    for (let i = 0; i < docs.length; i += 500) {
      await Expense.collection.insertMany(docs.slice(i, i + 500) as any[], { ordered: true });
    }
  }
  return plan;
}

/** Takes out what a run added, from its backup: the imported expenses, then the subcategories it added if nothing uses them. */
export async function undoImport(file: string, write: boolean): Promise<string[]> {
  const b = JSON.parse(fs.readFileSync(file, "utf8")) as { batch: string; orgs: { orgId: string; subcategoriesAdded: string[]; keys: string[] }[] };
  const out: string[] = [];
  for (const o of b.orgs) {
    const oid = new Types.ObjectId(o.orgId);
    const n = await Expense.countDocuments({ organizationId: oid, "source.kind": "import", "source.key": { $in: o.keys } });
    out.push(`${o.orgId}: ${n} imported expense(s) out${o.subcategoriesAdded.length ? `, ${o.subcategoriesAdded.join(", ")} out if unused` : ""}`);
    if (!write) continue;
    for (let i = 0; i < o.keys.length; i += 1000) {
      await Expense.deleteMany({ organizationId: oid, "source.kind": "import", "source.key": { $in: o.keys.slice(i, i + 1000) } });
    }
    for (const label of o.subcategoriesAdded) {
      const [category, name] = label.split(" › ");
      const cat = await ExpenseCategory.findOne({ organizationId: oid, slug: category }).lean<any>();
      const sub = (cat?.subcategories ?? []).find((s: { name: string }) => s.name === name);
      if (sub && !(await Expense.exists({ organizationId: oid, category, subcategory: sub.slug }))) {
        await ExpenseCategory.updateOne({ organizationId: oid, slug: category }, { $pull: { subcategories: { slug: sub.slug } } });
      }
    }
    // Numbering starts again from HX-00001 once nothing imported is left.
    if (!(await Expense.exists({ organizationId: oid, "source.kind": "import" }))) await Sequence.deleteOne({ organizationId: oid, key: SEQ_KEY });
  }
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
    console.log(write ? "\nTaken out." : "\nNothing written — run again with --write.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const file = arg("--file"), orgAed = arg("--org-aed"), orgInr = arg("--org-inr");
  if (!file || !orgAed || !orgInr) {
    console.error("--file <data.json> --org-aed <organization id> --org-inr <organization id> are required");
    process.exit(1);
  }
  const print = (p: ImportPlan) => {
    console.log(`Batch ${p.batch}, entered and approved as ${p.by}.`);
    for (const o of p.orgs) {
      console.log(`\n== ${o.org} (${o.orgId}, ${o.currency})`);
      for (const pr of o.problems) console.log(`  PROBLEM: ${pr}`);
      for (const s of o.subcategoriesToAdd) console.log(`  subcategory added: ${s} (not in the P&L)`);
      const byCat = new Map<string, { n: number; t: number }>();
      for (const r of o.toImport) {
        const k = `${r.category} › ${r.subcategory}`;
        const g = byCat.get(k) ?? { n: 0, t: 0 };
        g.n++; g.t += r.totalMinor;
        byCat.set(k, g);
      }
      for (const [k, g] of [...byCat.entries()].sort()) console.log(`  ${String(g.n).padStart(5)}  ${money(g.t, o.currency).padStart(20)}  ${k}`);
      const total = o.toImport.reduce((t, r) => t + r.totalMinor, 0);
      console.log(`  — ${o.toImport.length} to import (${money(total, o.currency)}), ${o.toImport.filter((r) => r.needsReview).length} of them "needs review"; ${o.already} imported before; ${o.repeats} repeat an earlier row (same day, total, description and account) and are imported too`);
      if (o.overlaps.length) {
        console.log(`  ${o.overlaps.length} skipped — finance already has an expense that day for that total:`);
        for (const x of o.overlaps) console.log(`    row ${String(x.row).padEnd(5)} ${x.date} ${x.total.padStart(16)}  ${x.description}  ⇢ ${x.matches}`);
      }
    }
  };
  const dry = await importExpenses({ file, orgAed, orgInr, as: arg("--as"), write: false });
  const blocked = dry.orgs.some((o) => o.problems.length);
  if (write && !blocked) {
    const expect = Number(arg("--expect"));
    if (expect !== countOf(dry)) {
      print(dry);
      console.error(`\nRefusing to write: ${countOf(dry)} change(s), and --expect ${arg("--expect") ?? "(missing)"} was given.`);
      await mongoose.disconnect();
      process.exit(1);
    }
    const done = await importExpenses({ file, orgAed, orgInr, as: arg("--as"), write: true });
    print(done);
    console.log(`\n${countOf(done)} change(s) written. Backup: ${done.backup}\nUndo: bun src/scripts/expense-import.ts --undo ${done.backup} --write`);
  } else {
    print(dry);
    console.log(blocked
      ? "\nNothing written — fix the problems above first."
      : `\n${countOf(dry)} change(s). Nothing written — run again with --write --expect ${countOf(dry)}.`);
  }
  await mongoose.disconnect();
}
