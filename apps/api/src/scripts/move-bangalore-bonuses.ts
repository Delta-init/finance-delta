/**
 * Bangalore teams' bonuses that came to Delta HQ, moved to the Bangalore organization in rupees (the user, 2026-10-15:
 * "first move the current approved Tetra Commission approvals to the Bangalore org").
 *
 * Since 2026-10-15 Tetra Commission sends a Bangalore team's bonus to the Bangalore organization, in rupees
 * (modules/tetra-deposit). Before, they came to Delta HQ in dollars, and an approved one went on an AED invoice there
 * with an AED receipt. For each such bonus (type BONUS, not in the Bangalore organization) — those named with --ids
 * (Tetra Commission's request ids or finance's), else those whose team reads Bangalore/Banglore:
 *
 *   pending   moved to the Bangalore organization, in rupees, to be decided there;
 *   approved  its payment taken off the Delta HQ invoice — that invoice voided when the moved payments were all it
 *             had and Tetra Commission made it (its number stays, as a void record); then moved, in rupees, recorded
 *             on a rupee invoice in the Bangalore organization with a new receipt, the client emailed it (--no-email
 *             not to), and the decision sent to Tetra Commission again so it shows the new invoice;
 *   rejected / closed — left alone, as is one whose payment sits on a sales CRM's invoice (listed, to do by hand).
 *
 * The rupees: as typed in Tetra Commission when typed in rupees, else the dollars at its fixed 100 INR = $1; the
 * course's AED figures at its ₹27.248 per AED. The new invoice's salesperson is whoever approved it, if they are in
 * the Bangalore organization, else --salesperson <email> (someone who is).
 *
 * Reads and prints only, unless --write. Run it from apps/api on the server (Bun reads MONGODB_URI from the .env):
 *
 *   bun src/scripts/move-bangalore-bonuses.ts                                    # what it would do
 *   bun src/scripts/move-bangalore-bonuses.ts --bangalore-org <id>               # when the name doesn't find it
 *   bun src/scripts/move-bangalore-bonuses.ts --ids <id>[,<id>…]                 # only these
 *   bun src/scripts/move-bangalore-bonuses.ts --write [--salesperson a@b.com] [--no-email]
 */
import mongoose, { Types } from "mongoose";
import { formatMoney } from "@delta/shared";
import { TetraDepositModel } from "../modules/tetra-deposit/tetra-deposit.model";
import { COURSE_INVOICE_SOURCE, recordCoursePayment } from "../modules/tetra-deposit/course-invoice";

/** Tetra Commission's fixed rates: 1 USD = 3.67 AED, 1 INR = 0.010 USD. */
const INR_PER_USD = 100;
const INR_PER_AED = Math.round((1 / (3.67 * 0.01)) * 1e6) / 1e6;
const BANGALORE = /bangal|banglo|bengal/i;

export interface MoveRow { id: string; student: string; team: string; status: string; amount: string; outcome: string }

/** The request's amount in paise: the rupees typed, else its dollars (cents) at 100 INR = $1. */
function rupeesOf(row: any, usdMinor: number): number {
  const asked = Number(row.amountMinor) || 0;
  if (usdMinor === asked && String(row.amountCurrency ?? "").toUpperCase() === "INR" && Number(row.amountOriginal) > 0) return Math.round(Number(row.amountOriginal) * 100);
  return Math.round(usdMinor * INR_PER_USD);
}

export async function moveBangaloreBonuses(opts: {
  write: boolean; bangaloreOrgId?: string; ids?: string[]; salespersonEmail?: string; email?: boolean;
}): Promise<{ org: string; rows: MoveRow[] }> {
  const { Organization } = await import("../modules/organization/organization.model");
  const { User } = await import("../modules/user/user.model");
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { deletePayment, voidInvoice } = await import("../modules/invoice/invoice.service");

  const orgs = opts.bangaloreOrgId
    ? await Organization.find({ _id: new Types.ObjectId(opts.bangaloreOrgId) }).select("name").lean<any[]>()
    : await Organization.find({ name: BANGALORE }).select("name").lean<any[]>();
  if (orgs.length !== 1) {
    throw new Error(orgs.length ? `Several organizations look like Bangalore (${orgs.map((o) => `${o.name} ${o._id}`).join("; ")}) — name one with --bangalore-org` : "No Bangalore organization found — name it with --bangalore-org <id>");
  }
  const blr = orgs[0]._id as Types.ObjectId;
  const inBlr = async (userId: unknown) => !!userId && !!(await User.exists({ _id: userId, "memberships.organizationId": blr }));
  const fallback = opts.salespersonEmail
    ? await User.findOne({ email: opts.salespersonEmail.trim().toLowerCase(), "memberships.organizationId": blr }).select("_id name").lean<any>()
    : null;
  if (opts.salespersonEmail && !fallback) throw new Error(`${opts.salespersonEmail} is not in the Bangalore organization`);

  const ids = (opts.ids ?? []).filter(Boolean);
  const named = ids.length
    ? { $or: [{ externalId: { $in: ids } }, { _id: { $in: ids.filter((i) => Types.ObjectId.isValid(i)).map((i) => new Types.ObjectId(i)) } }] }
    : { team: BANGALORE };
  const rows = await TetraDepositModel.find({ type: "BONUS", organizationId: { $ne: blr }, ...named }).sort({ requestedAt: 1 }).lean<any[]>();
  const moving = new Set(rows.filter((r) => r.status === "pending" || r.status === "approved").map((r) => `tetra:${r.externalId}`));

  const out: MoveRow[] = [];
  for (const row of rows) {
    const base = {
      id: String(row._id), student: [row.student?.code, row.student?.name].filter(Boolean).join(" "), team: String(row.team ?? ""), status: String(row.status),
      amount: `${formatMoney(row.amountMinor, row.currency ?? "USD")} → ${formatMoney(rupeesOf(row, Number(row.amountMinor) || 0), "INR")}`,
    };
    if (row.status !== "pending" && row.status !== "approved") { out.push({ ...base, outcome: `left alone (${row.status})` }); continue; }

    // Where its money is now, if approved.
    const ci = row.courseInvoice ?? {};
    const hq: any = row.status === "approved" && ci.invoiceId ? await Invoice.findById(ci.invoiceId).lean<any>() : null;
    const ref = `tetra:${row.externalId}`;
    const payment = hq ? (hq.payments ?? []).find((p: any) => p.externalRef === ref) : null;
    if (hq && hq.external?.source !== COURSE_INVOICE_SOURCE) {
      out.push({ ...base, outcome: `left alone — its payment is on sales CRM invoice ${hq.invoiceNumber}; move it by hand` });
      continue;
    }
    const others = hq ? (hq.payments ?? []).filter((p: any) => !moving.has(String(p.externalRef ?? ""))) : [];
    const voids = !!hq && others.length === 0;
    const approverInBlr = await inBlr(row.decision?.decidedById);
    if (row.status === "approved" && !approverInBlr && !fallback) {
      out.push({ ...base, outcome: `needs --salesperson: ${row.decision?.decidedByName || "whoever approved it"} is not in the Bangalore organization` });
      continue;
    }
    const plan = row.status === "pending"
      ? "moved, to be decided in Bangalore"
      : `${hq ? `payment ${payment?.receiptNumber ?? ""} off ${hq.invoiceNumber}${voids ? ` (voided)` : ` (kept: ${others.length} other payment(s))`}; ` : ""}new rupee invoice + receipt in Bangalore${opts.email === false ? "" : ", client emailed"}`;
    if (!opts.write) { out.push({ ...base, outcome: `would be ${plan}` }); continue; }

    // 1. Off the Delta HQ invoice.
    if (hq && payment) {
      await deletePayment(String(hq.organizationId), String(hq._id), String(payment._id));
      const left = await Invoice.findById(hq._id).select("payments status").lean<any>();
      if (voids && (left?.payments ?? []).length === 0 && left?.status !== "void") await voidInvoice(String(hq.organizationId), String(hq._id));
    }
    // 2. Into the Bangalore organization, in rupees.
    const askedInr = rupeesOf(row, Number(row.amountMinor) || 0);
    const approvedInr = row.decision?.approvedAmountMinor !== undefined ? rupeesOf(row, Number(row.decision.approvedAmountMinor) || 0) : undefined;
    await TetraDepositModel.updateOne({ _id: row._id }, {
      $set: {
        organizationId: blr, currency: "INR", amountMinor: askedInr, academy: "bangalore",
        ...(row.coursePayment ? { "coursePayment.inrPerAed": INR_PER_AED } : {}),
        ...(approvedInr !== undefined ? { "decision.approvedAmountMinor": approvedInr } : {}),
      },
      $unset: { courseInvoice: "" },
      $push: {
        events: {
          at: new Date(), kind: "moved", byName: "",
          text: `Moved from Delta HQ to Bangalore, in rupees (${formatMoney(askedInr, "INR")})${hq ? ` — payment taken off ${hq.invoiceNumber}${voids ? ", which was voided" : ""}` : ""}`,
        },
      },
    });
    if (row.status === "pending") { out.push({ ...base, outcome: "moved — to be decided in Bangalore" }); continue; }
    // 3. On a rupee invoice there, with its receipt — the approver as salesperson, or the one named.
    const moved = await TetraDepositModel.findById(row._id).lean<any>();
    const asRecorded = approverInBlr ? moved : { ...moved, decision: { ...moved.decision, decidedById: fallback._id } };
    const done = await recordCoursePayment(asRecorded, { email: opts.email !== false });
    if (!done.ok) { out.push({ ...base, outcome: `moved, but NOT recorded in Bangalore: ${done.message} — record it by hand` }); continue; }
    // 4. Sent to Tetra Commission again by the worker, carrying the new invoice.
    await TetraDepositModel.updateOne({ _id: row._id }, {
      $set: { "delivery.state": "queued", "delivery.attempts": 0, "delivery.nextAttemptAt": new Date() },
      $unset: { "delivery.claimedAt": "", "delivery.lastError": "" },
    });
    const after = await TetraDepositModel.findById(row._id).lean<any>();
    out.push({ ...base, outcome: `moved — ${after?.courseInvoice?.created ? "made" : "on"} ${after?.courseInvoice?.invoiceNumber}, receipt ${after?.courseInvoice?.receiptNumber}` });
  }
  return { org: `${orgs[0].name} (${blr})`, rows: out };
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? String(process.argv[i + 1] ?? "") : ""; };
  const write = process.argv.includes("--write");
  const email = !process.argv.includes("--no-email");
  const { connectDb } = await import("../config/db");
  await connectDb();
  const { org, rows } = await moveBangaloreBonuses({
    write, email, bangaloreOrgId: arg("--bangalore-org") || undefined,
    ids: arg("--ids").split(",").map((s) => s.trim()).filter(Boolean), salespersonEmail: arg("--salesperson") || undefined,
  });
  console.log(`Bangalore organization: ${org}\n`);
  for (const r of rows) console.log(`${r.status.padEnd(9)} ${r.student.slice(0, 28).padEnd(28)} ${r.team.slice(0, 18).padEnd(18)} ${r.amount.padEnd(34)} ${r.outcome}`);
  const done = rows.filter((r) => r.outcome.startsWith(write ? "moved" : "would")).length;
  console.log(`\n${rows.length} Bangalore bonus(es) outside the Bangalore organization; ${done} ${write ? "moved" : "would be moved"}${write ? "" : " — nothing written. Run again with --write to do it."}`);
  await mongoose.disconnect();
}
