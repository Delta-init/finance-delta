/**
 * scripts/dead-receipts-relink.ts against a throwaway database (the user, 2026-11-10), storage answered by a stand-in:
 *   - a close whose receipt is gone (payment proof, declared receipt), with a document attached since: both pointed
 *     at it, the CS Portal told; the dry run before it changes nothing;
 *   - a dead document still on the invoice is taken off; a link storage gave no clear answer for is left alone;
 *   - two documents that could be it: listed, nothing changed — until --use names one;
 *   - nothing attached since: listed for a person; the live receipt of the other payment is never taken for it;
 *   - a voided invoice and one not asked for (--invoice) are left alone; running it again finds nothing;
 *   - --undo puts every field back as it was (ids and dates too) and tells the CS Portal again.
 *
 * Run through scripts/dead-receipts-relink-e2e.sh (throwaway mongod, no .env anywhere).
 */
import { mock } from "bun:test";
import mongoose, { Types } from "mongoose";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

const queued: string[] = [];
mock.module("../modules/integrations/commission-fee-update.service", () => ({
  queueFeeUpdate: async (id: unknown) => { queued.push(String(id)); return true; },
}));
const { relinkDeadReceipts, undoRelink } = await import("./dead-receipts-relink");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => String(JSON.stringify(v)).slice(0, 500);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const invoices = mongoose.connection.db!.collection("invoices");

/* Storage: these files are gone, this one gives no clear answer, everything else is there. */
const F = "https://files.e2e.test";
const GONE = new Set<string>(), UNSURE = new Set<string>();
const exists = async (url: string) => (UNSURE.has(url) ? null : !GONE.has(url));
const file = (key: string, extra: Record<string, unknown> = {}) => ({ name: key.split("/").pop()!.replace(/^\d{13}-/, ""), url: `${F}/${key}`, key, size: 10, mimeType: "image/jpeg", ...extra });
const gone = (f: { url: string }) => { GONE.add(f.url); return f; };
const ORG = new Types.ObjectId();
let n = 0;
const inv = (o: Record<string, unknown>) => ({
  _id: new Types.ObjectId(), organizationId: ORG, invoiceNumber: `IN-${String(++n).padStart(5, "0")}`, customerName: `Student ${n}`,
  status: "paid", totalMinor: 225_000, createdAt: new Date("2026-10-29"), ...o,
});
const pay = (method: string, proof?: { url: string; key: string }) => ({ _id: new Types.ObjectId(), method, amountMinor: 225_000, paidOn: new Date("2026-10-29"), proofUrl: proof?.url ?? "", proofKey: proof?.key ?? "" });
const enrol = (declared: { method: string; receipt?: unknown }[]) => ({ course: "Course 1", declaredPaidMinor: 225_000, declaredPayments: declared.map((d) => ({ amountMinor: 225_000, paidOn: "2026-10-29", ...d })) });

// A: the screenshot's case — the close receipt gone, a clearer copy attached since.
const aDead = gone(file("enrolment-receipts/lead-a/1793292590525-WhatsApp_Image.jpeg"));
const aNew = file("invoices/org/a/1793400000000-image.png", { uploadedAt: new Date("2026-11-01") });
const A = inv({ attachments: [aNew], payments: [pay("tamara", aDead)], enrolment: enrol([{ method: "tamara", receipt: aDead }]) });
// B: the dead close receipt still among the documents, a replacement after it, and an older unrelated document.
const bDead = gone(file("enrolment-receipts/lead-b/1793000000000-receipt.jpeg"));
const bOld = file("invoices/org/b/1792000000000-id-card.png");
const bNew = file("invoices/org/b/1793500000000-receipt-again.jpeg");
const B = inv({ attachments: [bDead, bOld, bNew], payments: [pay("tabby", bDead)], enrolment: enrol([{ method: "tabby", receipt: bDead }]) });
// C: two documents attached since — which one is for a person to say.
const cDead = gone(file("enrolment-receipts/lead-c/1793000000000-receipt.jpeg"));
const c1 = file("invoices/org/c/1793600000000-one.png"), c2 = file("invoices/org/c/1793700000000-two.png");
const C = inv({ attachments: [c1, c2], payments: [pay("card", cDead)], enrolment: enrol([{ method: "card", receipt: cDead }]) });
// D: two payments, one receipt gone, nothing attached since; the other payment's live receipt is not a replacement.
const dDead = gone(file("enrolment-receipts/lead-d/1793000000000-tamara.jpeg"));
const dLive = file("enrolment-receipts/lead-d/1793000000001-cash.jpeg");
const D = inv({ attachments: [dLive], payments: [pay("cash", dLive), pay("tamara", dDead)], enrolment: enrol([{ method: "cash", receipt: dLive }, { method: "tamara", receipt: dDead }]) });
// E: storage gave no clear answer — left alone.
const eUnsure = file("enrolment-receipts/lead-e/1793000000000-receipt.jpeg"); UNSURE.add(eUnsure.url);
const E = inv({ attachments: [file("invoices/org/e/1793800000000-x.png")], payments: [pay("card", eUnsure)], enrolment: enrol([{ method: "card", receipt: eUnsure }]) });
// V: voided; X: no enrolment (not a close).
const vDead = gone(file("enrolment-receipts/lead-v/1793000000000-receipt.jpeg"));
const V = inv({ status: "void", attachments: [file("invoices/org/v/1793900000000-y.png")], payments: [pay("card", vDead)], enrolment: enrol([{ method: "card", receipt: vDead }]) });
const xDead = gone(file("invoices/org/x/1793000000000-old.png"));
const X = inv({ attachments: [xDead, file("invoices/org/x/1793950000000-new.png")], payments: [pay("card", xDead)] });
await invoices.insertMany([A, B, C, D, E, V, X] as any[]);
const raw = async (x: { _id: Types.ObjectId }) => (await invoices.findOne({ _id: x._id })) as any;
const before = Object.fromEntries(await Promise.all([A, B, C, D, E].map(async (x) => [String(x._id), await raw(x)])));

step("The dry run");
const dir = mkdtempSync(join(tmpdir(), "dead-receipts-relink-"));
let res = await relinkDeadReceipts({ write: false, exists });
const row = (x: { invoiceNumber: string }) => res.rows.find((r) => r.invoiceNumber === x.invoiceNumber);
check("finds the closes with a receipt gone — not the voided one, not a non-close, not the unsure one",
  JSON.stringify(res.rows.map((r) => r.invoiceNumber).sort()) === JSON.stringify([A, B, C, D].map((x) => x.invoiceNumber).sort()), show(res.rows.map((r) => r.invoiceNumber)));
check("A: the proof and declared receipt gone, the document attached since is the replacement",
  row(A)?.dead.length === 2 && row(A)?.replacement?.key === aNew.key, show(row(A)));
check("B: the dead document too; the replacement is the one after it, not the older one", row(B)?.dead.length === 3 && row(B)?.replacement?.key === bNew.key, show(row(B)));
check("C: two could be it — nothing picked, says to name one", !row(C)?.replacement && /--use/.test(row(C)?.problem ?? "") && row(C)?.candidates.length === 2, show(row(C)));
check("D: nothing attached since — needs uploading again; the cash receipt never offered", !row(D)?.replacement && /uploading again/.test(row(D)?.problem ?? "") && !row(D)?.candidates.includes(dLive.key), show(row(D)));
check("nothing changed, nothing queued, no undo file", !res.undoFile && queued.length === 0 && JSON.stringify(await raw(A)) === JSON.stringify(before[String(A._id)]));

step("--invoice: just that one");
res = await relinkDeadReceipts({ write: false, exists, invoices: [A.invoiceNumber.toLowerCase()] });
check("only it", res.rows.length === 1 && res.rows[0]!.invoiceNumber === A.invoiceNumber, show(res.rows.map((r) => r.invoiceNumber)));

step("--write");
res = await relinkDeadReceipts({ write: true, exists, undoFile: join(dir, "undo.json") });
const a = await raw(A), b = await raw(B), c = await raw(C), d = await raw(D), e = await raw(E);
check("A: the payment's proof is the replacement", a.payments[0].proofUrl === aNew.url && a.payments[0].proofKey === aNew.key, show(a.payments));
check("A: …and the declared payment's receipt", a.enrolment.declaredPayments[0].receipt.url === aNew.url && a.enrolment.declaredPayments[0].receipt.key === aNew.key, show(a.enrolment.declaredPayments));
check("A: the payment keeps its id, amount and date", String(a.payments[0]._id) === String(A.payments[0]!._id) && a.payments[0].amountMinor === 225_000 && a.payments[0].paidOn instanceof Date);
check("B: the dead document taken off, the others kept", JSON.stringify(b.attachments.map((x: any) => x.key)) === JSON.stringify([bOld.key, bNew.key]) && b.payments[0].proofUrl === bNew.url, show(b.attachments));
check("C, D, E untouched", JSON.stringify(c) === JSON.stringify(before[String(C._id)]) && JSON.stringify(d) === JSON.stringify(before[String(D._id)]) && JSON.stringify(e) === JSON.stringify(before[String(E._id)]));
check("the CS Portal told about A and B", JSON.stringify(queued.sort()) === JSON.stringify([String(A._id), String(B._id)].sort()), show(queued));
check("rows say done", row(A)?.changed === true && row(A)?.queued === true && row(B)?.changed === true && !!res.undoFile);

step("Again");
queued.length = 0;
res = await relinkDeadReceipts({ write: true, exists, undoFile: join(dir, "undo-2.json") });
check("A and B found no more; C and D still listed; nothing queued", !row(A) && !row(B) && !!row(C) && !!row(D) && queued.length === 0, show(res.rows.map((r) => r.invoiceNumber)));

step("--use names C's");
res = await relinkDeadReceipts({ write: true, exists, use: { [C.invoiceNumber]: c2.key }, invoices: [C.invoiceNumber], undoFile: join(dir, "undo-3.json") });
const c3 = await raw(C);
check("pointed at the one named", c3.payments[0].proofUrl === c2.url && c3.enrolment.declaredPayments[0].receipt.url === c2.url, show(c3.payments));
res = await relinkDeadReceipts({ write: false, exists, use: { [D.invoiceNumber]: dLive.key }, invoices: [D.invoiceNumber] });
check("naming the other payment's receipt: refused", !row(D)?.replacement && /not a live document/.test(row(D)?.problem ?? ""), show(row(D)));

step("--undo");
queued.length = 0;
const put = await undoRelink(join(dir, "undo.json"));
const a2 = await raw(A), b2 = await raw(B);
check("A and B as they were — ids and dates too", put === 2 && JSON.stringify(a2.payments) === JSON.stringify(before[String(A._id)].payments)
  && JSON.stringify(a2.enrolment.declaredPayments) === JSON.stringify(before[String(A._id)].enrolment.declaredPayments)
  && JSON.stringify(b2.attachments) === JSON.stringify(before[String(B._id)].attachments)
  && a2.payments[0]._id instanceof Types.ObjectId && a2.payments[0].paidOn instanceof Date, show(a2.payments));
check("…and the CS Portal told again", JSON.stringify(queued.sort()) === JSON.stringify([String(A._id), String(B._id)].sort()), show(queued));

await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
