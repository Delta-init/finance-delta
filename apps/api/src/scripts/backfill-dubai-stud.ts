/**
 * DUBAI-STUD backfill (2026-11-20).
 *
 * Since 2026-11-20 a close from the Sales CRM, Draw or Remote that picked the Bangalore academy is tagged DUBAI-STUD
 * here, on the invoice and its client, and told to the LMS and CS Portal as a Dubai student (lib/dubai-student.ts).
 * This finds the ones from before — every such enrolment not voided or moved — and with --apply tags them.
 *
 * Tagging changes nothing that has already happened elsewhere. A student the LMS already made is still in its
 * Bangalore academy, and one CS Portal already has is still on a Bangalore team: the report ends with the commands
 * that move them there, filled in — the LMS's move-student-org.ts and CS Portal's dubai-students.ts, each a dry run
 * first. Enrolments still waiting (not approved yet, or queued and not sent) need nothing more: the tag is read when
 * they are sent.
 *
 * Run it from apps/api (Bun reads the .env there):
 *
 *   bun run backfill:dubai-stud            # what it would tag, and what is where
 *   bun run backfill:dubai-stud --apply    # tag them
 *
 * --invoice IN-00050,IN-00046 (repeatable) narrows it to those invoice numbers; --org "<name or id>" to one
 * organization. A number named and not found among them stops the run before anything is changed.
 */

import mongoose, { Types } from "mongoose";
import { enrolmentAcademy, enrolmentCrm } from "@delta/shared";
import { connectDb } from "../config/db";
import { Invoice } from "../modules/invoice/invoice.model";
import { Customer } from "../modules/customer/customer.model";
import { Organization } from "../modules/organization/organization.model";
import { LmsProvision } from "../modules/integrations/lms-provision.model";
import { dubaiStudTagId, soldAsDubaiStudent, tagDubaiStudent } from "../lib/dubai-student";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const INVOICES = [...new Set(argv.flatMap((a, i) => (a === "--invoice" && argv[i + 1] ? argv[i + 1]!.split(",") : []))
  .map((n) => n.trim().toUpperCase()).filter(Boolean))];
const ORG = argv.includes("--org") ? String(argv[argv.indexOf("--org") + 1] ?? "").trim() : "";

type Row = {
  _id: Types.ObjectId; organizationId: Types.ObjectId; invoiceNumber: string; customerId?: Types.ObjectId; customerName?: string;
  status?: string; approval?: { state?: string }; tagIds?: Types.ObjectId[];
  enrolment?: { crm?: string; academy?: string; course?: string }; external?: { source?: string };
};

const CRM_NAMES: Record<string, string> = { delta: "Sales CRM", draw: "Draw", remote: "Remote" };

async function main(): Promise<void> {
  if (argv.includes("--invoice") && !INVOICES.length) {
    console.error("--invoice needs invoice numbers, e.g. --invoice IN-00050,IN-00046");
    process.exit(1);
  }
  await connectDb();

  const orgs = await Organization.find({}).select("name").lean<Array<{ _id: Types.ObjectId; name: string }>>();
  const orgName = (id: unknown) => orgs.find((o) => String(o._id) === String(id))?.name ?? String(id);
  let orgFilter: Types.ObjectId | null = null;
  if (ORG) {
    const o = orgs.find((x) => String(x._id) === ORG || x.name.toLowerCase() === ORG.toLowerCase());
    if (!o) { console.error(`No organization "${ORG}". Nothing was changed.`); await mongoose.disconnect(); process.exit(1); }
    orgFilter = o._id;
  }

  const found = await Invoice.find({
    "enrolment.academy": "bangalore",
    status: { $ne: "void" },
    "enrolment.movedTo": { $exists: false },
    ...(orgFilter ? { organizationId: orgFilter } : {}),
    ...(INVOICES.length ? { invoiceNumber: { $in: INVOICES } } : {}),
  })
    .select("organizationId invoiceNumber customerId customerName status approval tagIds enrolment.crm enrolment.academy enrolment.course external.source")
    .sort({ organizationId: 1, invoiceNumber: 1 })
    .lean<Row[]>();

  const rows = found.filter((r) => {
    const crm = enrolmentCrm(r.enrolment?.crm, r.external?.source);
    return soldAsDubaiStudent(crm, enrolmentAcademy(r.enrolment?.academy, crm));
  });

  if (INVOICES.length) {
    const missing = INVOICES.filter((n) => !rows.some((r) => r.invoiceNumber.toUpperCase() === n));
    if (missing.length) {
      console.error(`Not a Bangalore-academy close from the Sales CRM, Draw or Remote: ${missing.join(", ")}. Nothing was changed.`);
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  // The tag as each organization has it now (none yet is fine: --apply makes it).
  const tagOf = new Map<string, Types.ObjectId | null>();
  for (const id of new Set(rows.map((r) => String(r.organizationId)))) tagOf.set(id, await dubaiStudTagId(id, false));
  const hasTag = (ids: Types.ObjectId[] | undefined, org: Types.ObjectId) => {
    const t = tagOf.get(String(org));
    return !!t && (ids ?? []).some((x) => String(x) === String(t));
  };

  const customers = await Customer.find({ _id: { $in: rows.map((r) => r.customerId).filter(Boolean) } })
    .select("email tagIds").lean<Array<{ _id: Types.ObjectId; email?: string; tagIds?: Types.ObjectId[] }>>();
  const provisions = await LmsProvision.find({ invoiceId: { $in: rows.map((r) => r._id) } })
    .select("invoiceId status payload.email lmsUserId commission.state commission.studentCode")
    .lean<Array<{ invoiceId: Types.ObjectId; status?: string; payload?: { email?: string }; lmsUserId?: string; commission?: { state?: string; studentCode?: string } }>>();

  console.log(`${rows.length} enrolment${rows.length === 1 ? "" : "s"} sold for the Bangalore academy by the Sales CRM, Draw or Remote${INVOICES.length ? " (of those named)" : ""}:\n`);
  const lmsMoves: string[] = [];
  const csMoves: string[] = [];
  let toTag = 0;
  for (const r of rows) {
    const crm = enrolmentCrm(r.enrolment?.crm, r.external?.source) ?? "";
    const customer = customers.find((c) => String(c._id) === String(r.customerId));
    const p = provisions.find((x) => String(x.invoiceId) === String(r._id));
    const invoiceTagged = hasTag(r.tagIds, r.organizationId);
    const clientTagged = !customer || hasTag(customer.tagIds, r.organizationId);
    if (!invoiceTagged || !clientTagged) toTag++;

    const lms = !p ? "not sent (waits for approval)"
      : p.status === "sent" ? "in the LMS — move to Dubai"
      : `${p.status} — goes as Dubai when sent`;
    const cs = !p?.commission?.state ? "—"
      : p.commission.state === "sent" ? `${p.commission.studentCode ?? "student"} — move to a Dubai team`
      : p.commission.state === "pending" ? "waiting — goes to a Dubai team when sent"
      : p.commission.state === "skipped" ? "not sent there (not a Forex course)"
      : p.commission.state;
    if (p?.status === "sent") {
      const email = (p.payload?.email || customer?.email || "").trim().toLowerCase();
      if (email) lmsMoves.push(email);
    }
    if (p?.commission?.state === "sent") csMoves.push(String(r._id));

    console.log(`  ${orgName(r.organizationId)} ${r.invoiceNumber} · ${r.customerName ?? ""} · ${CRM_NAMES[crm] ?? crm} · ${r.enrolment?.course ?? ""} · ${r.approval?.state ?? r.status ?? ""}`);
    console.log(`      tag: ${invoiceTagged && clientTagged ? "already on" : invoiceTagged ? "invoice has it, client to tag" : "to tag"} · LMS: ${lms} · CS Portal: ${cs}`);
  }

  if (!rows.length) { await mongoose.disconnect(); return; }

  if (APPLY) {
    let done = 0;
    for (const r of rows) {
      await tagDubaiStudent(String(r.organizationId), String(r._id), r.customerId ? String(r.customerId) : null);
      done++;
    }
    console.log(`\nTagged DUBAI-STUD: ${done} invoice${done === 1 ? "" : "s"} and their clients (${toTag} were missing it).`);
  } else {
    console.log(`\n${toTag} to tag. Nothing was changed — run again with --apply to tag them.`);
  }

  const uniqueEmails = [...new Set(lmsMoves)];
  if (uniqueEmails.length) {
    console.log(`\nLMS — ${uniqueEmails.length} already there, in the Bangalore academy. From the LMS's backend folder on its server (a report first; add --apply to move):`);
    console.log(`  bun src/scripts/move-student-org.ts --emails=${uniqueEmails.join(",")} --to=dubai`);
  }
  if (csMoves.length) {
    console.log(`\nCS Portal — ${csMoves.length} already there. From CS Portal's backend folder on its server (a dry run first; add --write to move):`);
    console.log(`  bun src/scripts/dubai-students.ts --invoice-ids ${csMoves.join(",")}`);
  }
  if (!APPLY && (uniqueEmails.length || csMoves.length)) {
    console.log("\nTag them here first (--apply), then move them in the LMS and CS Portal.");
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
