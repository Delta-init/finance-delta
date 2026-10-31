/**
 * The payments taken at the close of every enrolment approved before approval recorded them (the user, 2026-11-01:
 * "why 0 when he collected fully" — IN-00076, closed and approved on 2 October with AED 2,250 collected, had no payment
 * on its invoice: overdue, and its salesperson's commission 0, which counts what the invoice has collected).
 *
 * Approval records the close's payments on the invoice since 2026-10-05; an enrolment approved before has its approval
 * and none of them. Each such invoice — approved, nothing paid on it, its approval never having dealt with them — gets
 * them recorded now by the same code approval uses (invoice.service recordDeclaredAfterApproval): method, the day paid,
 * the close's receipt, its bank account and line, then LMS access and CS Portal's fee update. One its approval would
 * leave out (more than the invoice, an EMI with no terms) is listed and left.
 *
 * Reads and prints only, unless --write; --write saves an undo file first and adds to it as it goes (--undo <file>
 * takes those payments off again, their bank lines too). Run it from apps/api on the server:
 *
 *   bun src/scripts/record-declared-payments.ts [--invoice IN-00001]           # what it would record
 *   bun src/scripts/record-declared-payments.ts --write --expect N             # N = the "would record" count shown
 *   bun src/scripts/record-declared-payments.ts --undo <file>
 */
import mongoose from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";
import { formatMoney } from "@delta/shared";

export interface Row { invoice: string; customer: string; issued: string; outcome: "would record" | "recorded" | "left out"; detail: string }
interface Undo { invoices: Array<{ id: string; organizationId: string; number: string; paymentIds: string[] }> }

export async function recordDeclared(o: { write: boolean; expect?: number; invoice?: string; undoFile?: string }): Promise<{ rows: Row[]; undoFile?: string }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { recordDeclaredAfterApproval } = await import("../modules/invoice/invoice.service");
  const candidates = await Invoice.find({
    ...(o.invoice ? { invoiceNumber: o.invoice.trim() } : {}),
    "approval.state": "approved",
    status: { $ne: "void" },
    enrolment: { $ne: null },
    "payments.0": { $exists: false },
    "enrolment.declaredPaymentsOnApproval.state": { $exists: false },
    $or: [{ "enrolment.declaredPaidMinor": { $gt: 0 } }, { "enrolment.declaredPayments.0": { $exists: true } }],
  }).select("organizationId invoiceNumber customerName issueDate currency").sort({ issueDate: 1, invoiceNumber: 1 }).lean<any[]>();

  const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : "");
  const describe = (cur: string, ps: { method: string; amountMinor: number; paidOn: string; proof: boolean }[]) =>
    ps.map((p) => `${formatMoney(p.amountMinor, cur)} ${p.method.replace(/_/g, " ")} on ${p.paidOn}${p.proof ? " with its receipt" : " (no receipt)"}`).join(" + ");

  // What each would get — the same code, nothing saved.
  const plans: { inv: any; row: Row }[] = [];
  for (const inv of candidates) {
    const r = await recordDeclaredAfterApproval(String(inv.organizationId), String(inv._id), { dryRun: true });
    const base = { invoice: String(inv.invoiceNumber), customer: String(inv.customerName ?? ""), issued: day(inv.issueDate) };
    plans.push({ inv, row: r.recorded ? { ...base, outcome: "would record", detail: describe(inv.currency ?? "AED", r.payments) } : { ...base, outcome: "left out", detail: r.skipped ?? "" } });
  }
  const todo = plans.filter((p) => p.row.outcome === "would record");
  if (!o.write) return { rows: plans.map((p) => p.row) };
  if (o.expect !== undefined && o.expect !== todo.length) throw new Error(`--expect ${o.expect}, but ${todo.length} would be recorded now — run it again without --write and check`);

  const undo: Undo = { invoices: [] };
  const undoFile = o.undoFile ?? `record-declared-payments-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const save = () => {
    writeFileSync(undoFile, JSON.stringify(undo, null, 2));
    if (!Array.isArray((JSON.parse(readFileSync(undoFile, "utf8")) as Undo).invoices)) throw new Error(`The undo file ${undoFile} didn't read back — stopped`);
  };
  save();
  for (const p of todo) {
    const r = await recordDeclaredAfterApproval(String(p.inv.organizationId), String(p.inv._id));
    if (!r.recorded) { p.row.outcome = "left out"; p.row.detail = r.skipped ?? "changed since the dry run"; continue; }
    undo.invoices.push({ id: String(p.inv._id), organizationId: String(p.inv.organizationId), number: p.row.invoice, paymentIds: r.payments.map((x) => x.id) });
    save();
    p.row.outcome = "recorded";
    p.row.detail = describe(p.inv.currency ?? "AED", r.payments);
  }
  return { rows: plans.map((p) => p.row), undoFile };
}

/** Takes the payments a run recorded off again (their bank lines with them), as if never recorded. */
export async function undoRecordDeclared(file: string): Promise<number> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { deletePayment } = await import("../modules/invoice/invoice.service");
  const u = JSON.parse(readFileSync(file, "utf8")) as Undo;
  let n = 0;
  for (const inv of u.invoices) {
    for (const pid of inv.paymentIds) {
      if (await Invoice.exists({ _id: inv.id, "payments._id": pid })) { await deletePayment(inv.organizationId, inv.id, pid); n++; }
    }
    await Invoice.updateOne({ _id: inv.id }, { $unset: { "enrolment.declaredPaymentsOnApproval": "" } });
  }
  return n;
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    if (arg("--undo")) {
      console.log(`Took ${await undoRecordDeclared(arg("--undo"))} payment(s) off again, from ${arg("--undo")}.`);
    } else {
      const write = argv.includes("--write");
      const { rows, undoFile } = await recordDeclared({ write, expect: arg("--expect") ? Number(arg("--expect")) : undefined, invoice: arg("--invoice") || undefined });
      for (const r of rows) console.log(`${r.invoice.padEnd(10)} ${r.issued} ${r.customer.slice(0, 24).padEnd(24)} ${r.outcome.padEnd(12)} ${r.detail}`);
      const count = (x: Row["outcome"]) => rows.filter((r) => r.outcome === x).length;
      console.log(`\n${rows.length} approved enrolment(s) with nothing recorded of what was collected at the close: ${write ? `${count("recorded")} recorded` : `${count("would record")} would be recorded`}, ${count("left out")} left out.`);
      if (undoFile) console.log(`Undo file: ${undoFile}`);
      if (!write) console.log(`Nothing written. To do it: bun src/scripts/record-declared-payments.ts --write --expect ${count("would record")}`);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  // The fee updates and LMS access are queued in the background: a moment for them before the connection closes.
  await new Promise((r) => setTimeout(r, 3000));
  await mongoose.disconnect();
}
