/**
 * Receipts whose file is gone from storage, pointed at the one finance attached instead (the user, 2026-11-10).
 *
 * Until a2993d8 finance deleted a file from storage when a document was taken off an invoice. A sales CRM's close
 * receipt is the same file as the payment's proof and the declared payment's receipt, and the CS Portal links it too —
 * so taking it off (often to attach a clearer copy) left those links dead: the CS Portal's MT5 Approvals says "This
 * receipt is no longer in storage". Six close receipts uploaded 20–29 Oct 2026 were found that way.
 *
 * For every enrolment invoice, each receipt it links — its documents, each recorded payment's proof, each declared
 * payment's receipt — is checked against storage (HEAD). For a link whose file is gone (404):
 *   - the invoice's replacement is the one live document uploaded after the dead file that nothing else on it uses
 *     (accounts re-attached it, as on IN-00254); or the one named with --use IN-00254=<document key>;
 *   - the payment's proof and the declared payment's receipt are pointed at it, and the dead document taken off;
 *   - none, or several to choose from: listed for a person (re-upload it, or say which with --use).
 * Then one fee update per changed invoice is queued, so the CS Portal shows the replacement.
 *
 * Reads and prints only, unless --write. --write saves an undo file first (--undo <file> puts it back and tells the
 * CS Portal again). Run it from apps/api on the server (Bun reads MONGODB_URI and COMMISSION_* from the .env there):
 *
 *   cd apps/api
 *   bun src/scripts/dead-receipts-relink.ts                                  # what it finds and would do
 *   bun src/scripts/dead-receipts-relink.ts --invoice IN-00254               # just one (repeatable)
 *   bun src/scripts/dead-receipts-relink.ts --use IN-00216=invoices/<org>/<id>/<file>   # the replacement, by hand
 *   bun src/scripts/dead-receipts-relink.ts --write                          # do it
 *   bun src/scripts/dead-receipts-relink.ts --undo dead-receipts-relink-undo-<time>.json
 *
 * Safe to run again: a link already pointed at a live file is left alone.
 */
import mongoose, { Types } from "mongoose";
import { writeFileSync, readFileSync } from "node:fs";
import { Invoice } from "../modules/invoice/invoice.model";
import { queueFeeUpdate } from "../modules/integrations/commission-fee-update.service";

/** Extended JSON: the undo file keeps ids and dates as they were, so putting it back writes the same types. */
const { EJSON } = mongoose.mongo.BSON;

type FileRef = { name?: string; url?: string; key?: string; size?: number; mimeType?: string; uploadedAt?: Date | string };
type Doc = {
  _id: Types.ObjectId; invoiceNumber?: string; customerName?: string;
  attachments?: FileRef[];
  payments?: { _id?: Types.ObjectId; method?: string; proofUrl?: string; proofKey?: string }[];
  enrolment?: { declaredPayments?: { method?: string; receipt?: FileRef }[] } | null;
};

export interface RelinkRow {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  /** The dead links: where on the invoice, and the file. */
  dead: { where: string; url: string }[];
  /** The live document taken as the replacement, or null. */
  replacement: FileRef | null;
  /** Why not, when there is none. */
  problem?: string;
  /** Live documents that could be it (for --use). */
  candidates: string[];
  changed?: boolean;
  queued?: boolean;
}
export interface Undo { at: string; invoices: { _id: string; invoiceNumber: string; attachments: unknown; payments: unknown; declaredPayments: unknown[] | null }[] }

const isLink = (u: unknown): u is string => /^https?:\/\//i.test(String(u ?? ""));
/** When a file was uploaded, from the time its key starts with (`…/<ms>-name`); 0 when it doesn't say. */
const uploadedMs = (f: { key?: string; url?: string; uploadedAt?: Date | string }) => {
  const m = String(f.key || f.url || "").match(/\/(\d{13})-/);
  if (m) return Number(m[1]);
  return f.uploadedAt ? new Date(f.uploadedAt).getTime() || 0 : 0;
};

/** Whether a stored file is there: true (2xx), false (404), null (anything else — left alone). */
export async function fileExists(url: string): Promise<boolean | null> {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "manual" });
    if (r.ok) return true;
    return r.status === 404 ? false : null;
  } catch {
    return null;
  }
}

export async function relinkDeadReceipts(opts: {
  write: boolean;
  invoices?: string[];
  use?: Record<string, string>;
  exists?: (url: string) => Promise<boolean | null>;
  undoFile?: string;
}): Promise<{ rows: RelinkRow[]; undoFile?: string }> {
  const exists = opts.exists ?? fileExists;
  const only = new Set((opts.invoices ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean));
  const use = Object.fromEntries(Object.entries(opts.use ?? {}).map(([k, v]) => [k.trim().toUpperCase(), v.trim()]));
  const docs = await Invoice.collection
    .find({ "enrolment.course": { $nin: [null, ""] }, status: { $ne: "void" } })
    .project({ invoiceNumber: 1, customerName: 1, attachments: 1, payments: 1, "enrolment.declaredPayments": 1 })
    .toArray() as unknown as Doc[];
  const picked = docs.filter((d) => !only.size || only.has(String(d.invoiceNumber ?? "").toUpperCase()));

  // Every file these invoices link, checked once.
  const urls = new Set<string>();
  for (const d of picked) {
    for (const a of d.attachments ?? []) if (isLink(a.url)) urls.add(a.url!);
    for (const p of d.payments ?? []) if (isLink(p.proofUrl)) urls.add(p.proofUrl!);
    for (const p of d.enrolment?.declaredPayments ?? []) if (isLink(p.receipt?.url)) urls.add(p.receipt!.url!);
  }
  const alive = new Map<string, boolean | null>();
  const list = [...urls];
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < list.length) { const u = list[next++]!; alive.set(u, await exists(u)); }
  }));
  const dead = (u: unknown) => isLink(u) && alive.get(u) === false;

  const rows: RelinkRow[] = [];
  const undo: Undo = { at: new Date().toISOString(), invoices: [] };
  const plans: { doc: Doc; replacement: FileRef }[] = [];
  for (const d of picked) {
    const found: RelinkRow["dead"] = [];
    (d.attachments ?? []).forEach((a, i) => { if (dead(a.url)) found.push({ where: `document ${i + 1}`, url: a.url! }); });
    (d.payments ?? []).forEach((p, i) => { if (dead(p.proofUrl)) found.push({ where: `payment ${i + 1} (${p.method ?? ""}) proof`, url: p.proofUrl! }); });
    (d.enrolment?.declaredPayments ?? []).forEach((p, i) => { if (dead(p.receipt?.url)) found.push({ where: `declared payment ${i + 1} (${p.method ?? ""}) receipt`, url: p.receipt!.url! }); });
    if (!found.length) continue;

    // A replacement: a live document nothing else on the invoice uses, uploaded after the dead file.
    const used = new Set<string>([
      ...(d.payments ?? []).map((p) => String(p.proofUrl ?? "")),
      ...(d.enrolment?.declaredPayments ?? []).map((p) => String(p.receipt?.url ?? "")),
    ].filter((u) => u && !dead(u)));
    const since = Math.min(...found.map((f) => uploadedMs({ url: f.url })).filter((n) => n > 0), Number.MAX_SAFE_INTEGER);
    const live = (d.attachments ?? []).filter((a) => isLink(a.url) && alive.get(a.url!) === true && !used.has(a.url!));
    const candidates = live.filter((a) => uploadedMs(a) > (since === Number.MAX_SAFE_INTEGER ? 0 : since));
    const row: RelinkRow = {
      invoiceId: String(d._id), invoiceNumber: d.invoiceNumber ?? "", customerName: d.customerName ?? "",
      dead: found, replacement: null, candidates: live.map((a) => String(a.key || a.url)),
    };
    const named = use[String(d.invoiceNumber ?? "").toUpperCase()];
    if (named) {
      const hit = live.find((a) => a.key === named || a.url === named);
      if (hit) row.replacement = hit;
      else row.problem = `--use ${d.invoiceNumber}=${named}: not a live document on this invoice nothing else uses`;
    } else if (candidates.length === 1) {
      row.replacement = candidates[0]!;
    } else {
      row.problem = candidates.length
        ? `${candidates.length} documents could be it — say which with --use ${d.invoiceNumber}=<key>`
        : "no document attached since — the receipt needs uploading again";
    }
    rows.push(row);
    if (row.replacement) plans.push({ doc: d, replacement: row.replacement });
  }

  if (!opts.write || !plans.length) return { rows };

  // The undo file first, read back whole, before anything changes.
  for (const { doc } of plans) {
    undo.invoices.push({
      _id: String(doc._id), invoiceNumber: doc.invoiceNumber ?? "",
      attachments: doc.attachments ?? [], payments: doc.payments ?? [], declaredPayments: doc.enrolment?.declaredPayments ?? null,
    });
  }
  const undoFile = opts.undoFile ?? `dead-receipts-relink-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(undoFile, EJSON.stringify(undo, undefined, 2, { relaxed: false }));
  const back = EJSON.parse(readFileSync(undoFile, "utf8")) as Undo;
  if (back.invoices.length !== undo.invoices.length) throw new Error(`The undo file ${undoFile} didn't read back whole — nothing changed`);

  for (const { doc, replacement: r } of plans) {
    const file = { name: r.name ?? "Receipt", url: r.url!, ...(r.key ? { key: r.key } : {}), ...(r.size ? { size: r.size } : {}), ...(r.mimeType ? { mimeType: r.mimeType } : {}) };
    const payments = (doc.payments ?? []).map((p) => (dead(p.proofUrl) ? { ...p, proofUrl: r.url!, proofKey: r.key ?? "" } : p));
    const declared = (doc.enrolment?.declaredPayments ?? []).map((p) => (dead(p.receipt?.url) ? { ...p, receipt: file } : p));
    const attachments = (doc.attachments ?? []).filter((a) => !dead(a.url));
    const res = await Invoice.collection.updateOne(
      { _id: doc._id },
      { $set: { payments, attachments, ...(doc.enrolment?.declaredPayments ? { "enrolment.declaredPayments": declared } : {}), updatedAt: new Date() } },
    );
    const row = rows.find((x) => x.invoiceId === String(doc._id))!;
    row.changed = res.modifiedCount === 1;
    if (row.changed) row.queued = await queueFeeUpdate(doc._id, "dead receipt pointed at its replacement", { evenIfNotSent: true });
  }
  return { rows, undoFile };
}

/** Puts back what an undo file saved, and tells the CS Portal again. */
export async function undoRelink(file: string): Promise<number> {
  const undo = EJSON.parse(readFileSync(file, "utf8")) as Undo;
  let n = 0;
  for (const inv of undo.invoices) {
    const _id = new Types.ObjectId(inv._id);
    const res = await Invoice.collection.updateOne({ _id }, {
      $set: { attachments: inv.attachments, payments: inv.payments, ...(inv.declaredPayments ? { "enrolment.declaredPayments": inv.declaredPayments } : {}), updatedAt: new Date() },
    });
    if (res.matchedCount) { n++; await queueFeeUpdate(_id, "dead receipt relink undone", { evenIfNotSent: true }); }
  }
  return n;
}

if (import.meta.main) {
  const argv = process.argv;
  const all = (flag: string) => argv.reduce<string[]>((acc, a, i) => (a === flag && argv[i + 1] ? [...acc, argv[i + 1]!] : acc), []);
  const { connectDb } = await import("../config/db");
  await connectDb();
  const undoArg = all("--undo")[0];
  if (undoArg) {
    console.log(`Put back ${await undoRelink(undoArg)} invoice(s) from ${undoArg}, and queued them for the CS Portal.`);
  } else {
    const write = argv.includes("--write");
    const use = Object.fromEntries(all("--use").map((s) => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
    const { rows, undoFile } = await relinkDeadReceipts({ write, invoices: all("--invoice"), use });
    for (const r of rows) {
      console.log(`\n${r.invoiceNumber}  ${r.customerName}`);
      for (const d of r.dead) console.log(`   gone: ${d.where} — ${d.url}`);
      if (r.replacement) console.log(`   → ${r.replacement.name ?? ""} (${r.replacement.key ?? r.replacement.url})${write ? (r.changed ? `  · done${r.queued ? ", CS Portal told" : ", CS Portal NOT told"}` : "  · NOT changed") : ""}`);
      else console.log(`   ✗ ${r.problem}${r.candidates.length ? `\n     live documents: ${r.candidates.join(", ")}` : ""}`);
    }
    const fixable = rows.filter((r) => r.replacement).length;
    console.log(`\n${rows.length} invoice(s) with a receipt gone from storage; ${fixable} with a replacement${write ? " — pointed at it" : " — nothing changed. Run again with --write to point them at it"}; ${rows.length - fixable} need a person.`);
    if (undoFile) console.log(`Undo file: ${undoFile}`);
  }
  await mongoose.disconnect();
}
