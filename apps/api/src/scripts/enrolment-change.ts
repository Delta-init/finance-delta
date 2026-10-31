/**
 * An approved enrolment moved to another course, with what was paid for it (the user, 2026-10-31: a student closed on
 * one course was upgraded on the night to a bigger one, paid in three Tabby payments — "change the course and the
 * amount, and the receipts").
 *
 * On the invoice: its line becomes the new course from the catalogue at the new price (updateInvoice — totals, status,
 * CS Portal's fee update, as an edit on the invoice screen does; the approval stays); the receipt on its first payment
 * is replaced; each further payment is recorded as the invoice screen records one (its bank line, the LMS access it
 * pays for, CS Portal's fee update), with its receipt, a receipt number and, asked, the receipt emailed to the client.
 * The enrolment says the new course, and the LMS opens the courses it adds (extraCourses, sent by the provisioning
 * worker).
 *
 * Names and files come on the command line. Reads and prints only, unless --write; --write saves an undo file first
 * and adds to it as it goes (--undo <file> takes the payments it recorded off again and puts the rest back — an email
 * sent or an LMS course already opened stays). Run it from apps/api on the server:
 *
 *   bun src/scripts/enrolment-change.ts --invoice IN-00001 --course "<course as the CRM names it>" --item <catalogue item id | none --lms <slug>,<slug>>
 *     --price 5500 [--proof <file for the first payment>] [--pay "<amount>|<method>|<YYYY-MM-DD>|<reference>|<file>"]…
 *     [--email] [--write]
 *   bun src/scripts/enrolment-change.ts --undo <file>
 *
 * Without --item it lists the catalogue's items whose name has the words of --course in it, to choose from.
 */
import mongoose, { Types } from "mongoose";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { formatMoney, PAYMENT_METHODS } from "@delta/shared";

export type Upload = (key: string, file: { buffer: Buffer; mimeType: string; originalName: string }) => Promise<{ url: string; key: string; size: number; mimeType: string; originalName: string }>;

export interface NewPayment { amountMinor: number; method: string; paidOn: string; reference: string; file: string }
export interface ChangeOpts {
  invoice: string; course: string; item?: string; priceMinor: number;
  /** With item "none": the LMS courses the line opens, as the CRM maps the course (a course with no catalogue item). */
  lms?: string[];
  proof?: string; payments: NewPayment[]; email: boolean; write: boolean; undoFile?: string;
  /** The file store (R2 on the server); the checks pass their own. */
  upload?: Upload;
}

interface Undo {
  invoiceId: string; organizationId: string;
  before: Record<string, unknown>;
  addedPaymentIds: string[];
  addedExtraSlugs: string[];
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic", ".pdf": "application/pdf" };
const fileOf = (path: string) => {
  if (!existsSync(path)) throw new Error(`No such file: ${path}`);
  const mimeType = MIME[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`${path}: a receipt is a jpg, png, webp, heic or pdf`);
  return { buffer: readFileSync(path), mimeType, originalName: basename(path) };
};

export function parsePay(v: string): NewPayment {
  const [amount, method, paidOn, reference, file] = v.split("|").map((s) => s.trim());
  const amountMinor = Math.round(Number(amount) * 100);
  if (!(amountMinor > 0)) throw new Error(`--pay "${v}": the amount first`);
  if (!(PAYMENT_METHODS as readonly string[]).includes(method ?? "")) throw new Error(`--pay "${v}": the method is one of ${PAYMENT_METHODS.join(", ")}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn ?? "")) throw new Error(`--pay "${v}": the date paid as YYYY-MM-DD`);
  if (!file) throw new Error(`--pay "${v}": write it as "<amount>|<method>|<YYYY-MM-DD>|<reference>|<file>"`);
  return { amountMinor, method: method!, paidOn: paidOn!, reference: reference ?? "", file };
}

async function models() {
  const [{ Invoice }, { Item }, { Customer }, { LmsProvision }] = await Promise.all([
    import("../modules/invoice/invoice.model"), import("../modules/inventory/item.model"),
    import("../modules/customer/customer.model"), import("../modules/integrations/lms-provision.model"),
  ]);
  return { Invoice, Item, Customer, LmsProvision } as Record<string, mongoose.Model<any>>;
}

const BEFORE_FIELDS = ["lineItems", "subtotalMinor", "discountTotalMinor", "taxBreakdown", "taxTotalMinor", "roundOffMinor", "totalMinor", "balanceMinor", "amountPaidMinor", "status", "enrolment", "payments"] as const;

export async function changeEnrolment(o: ChangeOpts): Promise<{ lines: string[]; undoFile?: string; items?: string[] }> {
  const M = await models();
  const inv: any = await M.Invoice!.findOne({ invoiceNumber: o.invoice.trim() }).lean();
  if (!inv) throw new Error(`No invoice ${o.invoice}`);
  const orgId = String(inv.organizationId);
  if (!inv.enrolment) throw new Error(`${o.invoice} is not an enrolment`);
  const approval = inv.approval?.state;
  if (approval && approval !== "approved") throw new Error(`${o.invoice} is ${approval}, not approved — change it in the CRM instead`);
  const course = o.course.trim();
  if (course.length < 3) throw new Error("--course: the course as the CRM names it");
  if (!(o.priceMinor > 0)) throw new Error("--price: the new price");
  const cur = inv.currency ?? "AED";

  if (!o.item) {
    const words = course.split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 3 && !/^(course|with|credit)$/i.test(w));
    const found = await M.Item!.find({ organizationId: inv.organizationId, isActive: { $ne: false }, ...(words.length ? { $and: words.map((w) => ({ name: { $regex: w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } })) } : {}) })
      .select("name sku unitPriceMinor lmsCourseSlug lmsCourseSlugs").limit(20).lean<any[]>();
    return { lines: [], items: found.map((i) => `${i._id} | ${i.name} | ${i.sku} | ${formatMoney(i.unitPriceMinor ?? 0, cur)} | LMS ${(i.lmsCourseSlugs?.length ? i.lmsCourseSlugs : [i.lmsCourseSlug]).filter(Boolean).join(", ") || "—"}`) };
  }
  // A course nobody added to the catalogue: a line of plain text, opening the LMS courses the CRM maps it to — as
  // finance takes such a close from the CRM (lmsCoursesFor falls back to them).
  const noItem = o.item === "none";
  if (!noItem && !Types.ObjectId.isValid(o.item)) throw new Error("--item: the catalogue item's id, or none (leave it out to list them)");
  const item: any = noItem ? null : await M.Item!.findOne({ _id: o.item, organizationId: inv.organizationId }).lean();
  if (!noItem && !item) throw new Error(`No catalogue item ${o.item} in this organization`);
  if (noItem && !o.lms?.length) throw new Error("--item none: say which LMS courses it opens with --lms <slug>,<slug>");
  const slugs: string[] = [...new Set<string>((noItem ? o.lms! : item.lmsCourseSlugs?.length ? item.lmsCourseSlugs : [item.lmsCourseSlug]).map((x: string) => x.trim()).filter(Boolean))];

  // Run once already: its payments are on the invoice.
  const repeat = o.payments.filter((p) => (inv.payments ?? []).some((x: any) => x.externalRef === refOf(inv, p)));
  if (repeat.length) throw new Error(`Recorded already: ${repeat.map((p) => p.reference).join(", ")} — nothing to do twice`);
  // What is paid now, and with these.
  const paid = (inv.payments ?? []).reduce((s: number, p: any) => s + (p.amountMinor ?? 0), 0);
  const adding = o.payments.reduce((s, p) => s + p.amountMinor, 0);
  if (o.priceMinor < paid + adding) throw new Error(`${formatMoney(paid + adding, cur)} would be paid on a ${formatMoney(o.priceMinor, cur)} invoice — the price is too low or a payment is too much`);
  const first = (inv.payments ?? [])[0];
  if (o.proof && !first) throw new Error("--proof: there is no payment on it to put the receipt on");
  const files = [o.proof, ...o.payments.map((p) => p.file)].filter(Boolean).map((f) => fileOf(f!));
  const customer: any = await M.Customer!.findById(inv.customerId).select("name email").lean();
  const provision: any = await M.LmsProvision!.findOne({ invoiceId: inv._id }).lean();
  const opened = new Set<string>([provision?.payload?.courseSlug, ...(provision?.extraCourses ?? []).map((e: any) => e.slug)].filter(Boolean));
  const toOpen = slugs.filter((s) => !opened.has(s));

  const lines = [
    `${inv.invoiceNumber} · ${customer?.name ?? ""} <${customer?.email ?? "no email"}> · ${approval ?? "no approval"} · ${inv.status}`,
    `line:     ${inv.lineItems?.[0]?.description} ${formatMoney(inv.totalMinor ?? 0, cur)}  →  ${course} ${formatMoney(o.priceMinor, cur)} (${item ? `item ${item.name}` : "no catalogue item"})`,
    ...(o.proof ? [`receipt:  payment 1 (${formatMoney(first.amountMinor, cur)} ${first.method}) gets ${basename(o.proof)} in place of its old one`] : []),
    ...o.payments.map((p, i) => `payment:  + ${formatMoney(p.amountMinor, cur)} ${p.method} on ${p.paidOn} ref ${p.reference || "—"} · ${basename(p.file)}${o.email ? ` · receipt emailed to ${customer?.email || "nobody (no email)"}` : ""}${i === o.payments.length - 1 ? "" : ""}`),
    `after:    ${formatMoney(o.priceMinor, cur)} total, ${formatMoney(paid + adding, cur)} paid, ${formatMoney(o.priceMinor - paid - adding, cur)} owed`,
    `LMS:      ${toOpen.length ? `opens ${toOpen.join(", ")} too` : "nothing more to open"}${provision ? "" : " (no LMS record — not opened by finance)"}`,
    `files:    ${files.map((f) => `${f.originalName} ${Math.round(f.buffer.length / 1024)} KB`).join(", ") || "none"}`,
  ];
  if (!o.write) return { lines };

  const upload: Upload = o.upload ?? (async (key, f) => {
    const { uploadFile, storageConfigured } = await import("../lib/storage");
    if (!storageConfigured()) throw new Error("File storage is not configured on this server");
    return uploadFile({ key, ...f });
  });
  const keyFor = (f: string) => `invoices/${orgId}/${inv._id}/proof-${Date.now()}-${basename(f).replace(/[^a-zA-Z0-9._-]/g, "_")}`;

  // Saved before anything changes, and again as payments are added.
  const undo: Undo = {
    invoiceId: String(inv._id), organizationId: orgId,
    before: Object.fromEntries(BEFORE_FIELDS.map((k) => [k, inv[k]])), addedPaymentIds: [], addedExtraSlugs: [],
  };
  const undoFile = o.undoFile ?? `enrolment-change-undo-${inv.invoiceNumber}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const save = () => {
    writeFileSync(undoFile, JSON.stringify(undo, null, 2));
    if (!(JSON.parse(readFileSync(undoFile, "utf8")) as Undo).invoiceId) throw new Error(`The undo file ${undoFile} didn't read back — stopped`);
  };
  save();

  const svc = await import("../modules/invoice/invoice.service");
  const { nextNumber } = await import("../modules/sequence/sequence.service");
  const done: string[] = [];

  // 1. The receipt on the first payment, and on the close's first payment.
  let firstReceipt: any;
  if (o.proof) {
    const up = await upload(keyFor(o.proof), fileOf(o.proof));
    firstReceipt = { name: up.originalName, url: up.url, key: up.key, size: up.size, mimeType: up.mimeType };
    await M.Invoice!.updateOne({ _id: inv._id, "payments._id": first._id }, { $set: { "payments.$.proofUrl": up.url, "payments.$.proofKey": up.key } });
    done.push(`receipt on payment 1 replaced (${up.originalName})`);
  }

  // 2. The line: the new course at its price.
  const taxes = (inv.lineItems?.[0]?.taxes ?? []).map((t: any) => ({ code: t.code, rate: t.rate }));
  await svc.updateInvoice(orgId, String(inv._id), {
    lineItems: [{ description: course, quantity: 1, unitPriceMinor: o.priceMinor, discountPct: 0, taxes, ...(item ? { itemId: String(item._id) } : {}), hsnSac: inv.lineItems?.[0]?.hsnSac ?? "" }],
  } as never, { all: true });
  done.push(`line → ${course}, ${formatMoney(o.priceMinor, cur)}`);

  // 3. The payments, as the invoice screen records them, each with its receipt and a receipt number.
  const declared: any[] = [];
  for (const p of o.payments) {
    const up = await upload(keyFor(p.file), fileOf(p.file));
    await svc.recordPayment(orgId, String(inv._id), {
      method: p.method, amountMinor: p.amountMinor, paidOn: p.paidOn, reference: p.reference,
      notes: `Paid towards ${course}`, accountName: "", chargesMinor: 0,
    } as never, undefined, { externalRef: refOf(inv, p), proofUrl: up.url });
    const now: any = await M.Invoice!.findById(inv._id).select("payments").lean();
    const added = (now.payments ?? []).find((x: any) => x.externalRef === refOf(inv, p));
    const receiptNumber = await nextNumber(orgId, "receipt", "RCT-");
    await M.Invoice!.updateOne({ _id: inv._id, "payments._id": added._id }, { $set: { "payments.$.proofKey": up.key, "payments.$.receiptNumber": receiptNumber } });
    undo.addedPaymentIds.push(String(added._id));
    save();
    declared.push({ method: p.method, amountMinor: p.amountMinor, paidOn: p.paidOn, receipt: { name: up.originalName, url: up.url, key: up.key, size: up.size, mimeType: up.mimeType } });
    done.push(`payment ${receiptNumber}: ${formatMoney(p.amountMinor, cur)} ${p.method} ${p.paidOn}`);
    if (o.email && customer?.email) {
      const after: any = await M.Invoice!.findById(inv._id).select("totalMinor amountPaidMinor balanceMinor").lean();
      const { sendNotice } = await import("../lib/email");
      const r = await sendNotice({
        log: { organizationId: orgId, kind: "payment_receipt", ref: { type: "invoice", id: String(inv._id), label: String(inv.invoiceNumber) } } as never,
        to: [customer.email],
        subject: `Payment receipt ${receiptNumber} — ${formatMoney(p.amountMinor, cur)}`,
        title: "Thank you — we have received your payment",
        lines: [
          `Dear ${customer.name || "student"}, this is your receipt for a payment towards ${course}.`,
          `Receipt ${receiptNumber} · ${formatMoney(p.amountMinor, cur)} · paid on ${p.paidOn} · ${p.method.replace(/_/g, " ")}${p.reference ? ` · ref ${p.reference}` : ""}`,
          `Invoice ${inv.invoiceNumber}: ${formatMoney(after.totalMinor ?? 0, cur)} in all, ${formatMoney(after.amountPaidMinor ?? 0, cur)} paid, ${formatMoney(after.balanceMinor ?? 0, cur)} left to pay.`,
        ],
      });
      done.push(r.sent ? `  emailed to ${customer.email}` : `  not emailed (${r.skipped ?? "mail not sent"})`);
    }
  }

  // 4. The enrolment: the new course, what was collected, each payment with its receipt.
  const firstDeclared = (inv.enrolment.declaredPayments ?? [])[0];
  const declaredPayments = [
    ...(firstDeclared ? [{ ...firstDeclared, ...(firstReceipt ? { receipt: firstReceipt } : {}) }] : []),
    ...(inv.enrolment.declaredPayments ?? []).slice(1),
    ...declared,
  ];
  await M.Invoice!.updateOne({ _id: inv._id }, {
    $set: {
      "enrolment.course": course,
      "enrolment.courses": [{ name: course, lmsCourseSlugs: slugs }],
      ...(slugs[0] ? { "enrolment.lmsCourseSlug": slugs[0] } : {}),
      "enrolment.declaredPaidMinor": paid + adding,
      "enrolment.declaredPayments": declaredPayments,
    },
  });
  done.push(`enrolment → ${course}, ${formatMoney(paid + adding, cur)} collected`);

  // 5. The LMS courses it adds — sent by the provisioning worker.
  if (provision && toOpen.length) {
    await M.LmsProvision!.updateOne({ _id: provision._id }, { $push: { extraCourses: { $each: toOpen.map((slug) => ({ slug, status: "pending", attempts: 0, nextAttemptAt: new Date() })) } } });
    undo.addedExtraSlugs = toOpen;
    save();
    done.push(`LMS: ${toOpen.join(", ")} queued to open`);
  }

  // CS Portal's figures follow (the services queue it too; this waits for it).
  const { queueFeeUpdate } = await import("../modules/integrations/commission-fee-update.service");
  await queueFeeUpdate(String(inv._id), "edit");
  return { lines: [...lines, "", ...done], undoFile };
}

const refOf = (inv: any, p: NewPayment) => `enrolment-change:${inv._id}:${p.reference || `${p.paidOn}-${p.amountMinor}`}`;

/** Takes off the payments a run recorded, puts back the line, totals, enrolment and first receipt, and the LMS courses not yet opened. */
export async function undoEnrolmentChange(file: string): Promise<string[]> {
  const M = await models();
  const u = JSON.parse(readFileSync(file, "utf8")) as Undo;
  const svc = await import("../modules/invoice/invoice.service");
  const out: string[] = [];
  for (const pid of u.addedPaymentIds) {
    const has = await M.Invoice!.exists({ _id: u.invoiceId, "payments._id": pid });
    if (has) { await svc.deletePayment(u.organizationId, u.invoiceId, pid); out.push(`payment ${pid} taken off (its bank line too)`); }
  }
  const before = u.before as any;
  await M.Invoice!.updateOne({ _id: u.invoiceId }, { $set: Object.fromEntries(BEFORE_FIELDS.filter((k) => k !== "payments").map((k) => [k, before[k]])) });
  const firstBefore = (before.payments ?? [])[0];
  if (firstBefore?._id) {
    await M.Invoice!.updateOne({ _id: u.invoiceId, "payments._id": firstBefore._id }, { $set: { "payments.$.proofUrl": firstBefore.proofUrl ?? "", "payments.$.proofKey": firstBefore.proofKey ?? "" } });
  }
  out.push("line, totals, status, enrolment and the first receipt put back");
  if (u.addedExtraSlugs.length) {
    const r = await M.LmsProvision!.updateOne({ invoiceId: u.invoiceId }, { $pull: { extraCourses: { slug: { $in: u.addedExtraSlugs }, status: { $ne: "sent" } } } });
    out.push(r.modifiedCount ? `LMS: ${u.addedExtraSlugs.join(", ")} no longer queued` : `LMS: ${u.addedExtraSlugs.join(", ")} opened already — close it in the LMS if it should not be`);
  }
  const { queueFeeUpdate } = await import("../modules/integrations/commission-fee-update.service");
  await queueFeeUpdate(u.invoiceId, "edit");
  return out;
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  const args = (n: string) => argv.flatMap((v, i) => (argv[i - 1] === n ? [v] : []));
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    if (arg("--undo")) {
      for (const l of await undoEnrolmentChange(arg("--undo"))) console.log(l);
    } else {
      const write = argv.includes("--write");
      const r = await changeEnrolment({
        invoice: arg("--invoice"), course: arg("--course"), item: arg("--item") || undefined, lms: arg("--lms") ? arg("--lms").split(",") : undefined,
        priceMinor: Math.round(Number(arg("--price")) * 100), proof: arg("--proof") || undefined,
        payments: args("--pay").map(parsePay), email: argv.includes("--email"), write,
      });
      if (r.items) {
        console.log(r.items.length ? `Catalogue items — pass one with --item <id>:\n${r.items.join("\n")}` : "No catalogue item has those words — pass --item <id>");
      } else {
        for (const l of r.lines) console.log(l);
        if (r.undoFile) console.log(`\nUndo file: ${r.undoFile}`);
        if (!write) console.log("\nNothing written. Check it, then run the same command with --write.");
      }
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  // The fee update and LMS access are queued in the background: a moment for them before the connection closes.
  await new Promise((r) => setTimeout(r, 3000));
  await mongoose.disconnect();
}
