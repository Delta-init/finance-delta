/**
 * Watch one enrolment travel the whole way: CRM → finance → approval → LMS.
 *
 * The e2e harness proves the code, against throwaway databases, and says
 * nothing about whether *these* servers are configured — which, after an
 * afternoon of unset variables, wrong branches and duplicate checkouts, is the
 * only question worth asking. So this runs against the real thing.
 *
 * Read that sentence again before using it. It raises a real enrolment in the
 * real books: a customer, an invoice taking the next number in the sequence,
 * and — once approved — a student in the production LMS who is emailed an
 * invitation. --cleanup can remove the invoice and the customer. It cannot
 * unsend the email, and the invoice number does not come back: deleting it
 * leaves a gap in the sequence, which in a numbered sales ledger is a thing
 * somebody may one day have to explain.
 *
 * Three steps, because the middle one is yours. Approving needs a signed-in
 * finance user, and a script that could approve on its own would be a way
 * around the approval. That is no loss here — pressing Approve and watching a
 * student appear is the very thing being verified.
 *
 *   bun run verify:lms --create --email you+test@example.com --phone +971500000000
 *       …then approve the invoice it names, in finance, as you would any other
 *   bun run verify:lms --check   --external <the id it printed>
 *   bun run verify:lms --cleanup --external <the id it printed>
 *
 * --course takes the CRM course name and defaults to Delta Wave Theory. It is
 * mapped through the same slug the real enrolments use, so a wrong mapping
 * fails here exactly as it would in production rather than being worked around.
 */
import mongoose, { Types } from "mongoose";
import { connectDb } from "../config/db";
import { Invoice } from "../modules/invoice/invoice.model";
import { Customer } from "../modules/customer/customer.model";
import { LmsProvision } from "../modules/integrations/lms-provision.model";
import { intakeEnrolment } from "../modules/integrations/enrolment-intake.service";
import { deleteInvoice, voidInvoice } from "../modules/invoice/invoice.service";
import { lmsConfigured } from "../lib/lms-client";
import { Organization } from "../modules/organization/organization.model";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string) => process.argv.includes(`--${name}`);

const COURSE = arg("course") ?? "Delta Wave Theory";
const SLUGS: Record<string, string> = {
  "delta wave theory": "delta-wave-theory-trading-programme",
  "digital marketing course": "digital-marketing",
  "market breakout theory": "market-break-out-trading-program",
};

/** Distinctive on purpose: anybody finding one of these in the books should be
    able to tell at a glance that it was a test rather than a sale. */
const PREFIX = "crm-verify-";

async function orgId(): Promise<string> {
  const org = await Organization.findOne({}).select("_id name").lean();
  if (!org) throw new Error("No organization in this database");
  return String(org._id);
}

async function create() {
  const email = arg("email");
  const phone = arg("phone");
  if (!email || !phone) {
    console.error("--create needs --email and --phone.");
    console.error("Both are yours to choose: this sends a real invitation to whatever address you give.");
    process.exit(1);
  }
  const slug = SLUGS[COURSE.toLowerCase()];
  if (!slug) {
    console.error(`No slug known for "${COURSE}". Known: ${Object.keys(SLUGS).join(", ")}`);
    process.exit(1);
  }

  const externalId = `${PREFIX}${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);

  const result = await intakeEnrolment(await orgId(), {
    externalId,
    // "crm", because provisioning deliberately ignores invoices raised inside
    // finance. A test that claimed to be anything else would test nothing.
    source: "crm",
    customer: { name: `LMS test ${new Date().toISOString().slice(0, 16)}`, email, phone },
    course: { name: COURSE, amountMinor: 100, lmsCourseSlug: slug },
    enrolledOn: today,
    declaredPaidMinor: 0,
    modeOfStudy: "online",
    language: "English",
  } as never);

  console.log(`\nraised ${result.invoiceNumber}  (external id ${externalId})`);
  if (result.flags?.length) console.log(`  finance flagged: ${result.flags.join(" · ")}`);
  console.log(`  customer: ${email} / ${phone}`);
  console.log(`  course:   ${COURSE} → ${slug}`);
  console.log(`\nNow approve ${result.invoiceNumber} in finance. Then:`);
  console.log(`  bun run verify:lms --check --external ${externalId}`);
  console.log(`\nAnd when you are done with it:`);
  console.log(`  bun run verify:lms --cleanup --external ${externalId}`);
}

async function rowFor(externalId: string) {
  const inv = await Invoice.findOne({ "external.externalId": externalId })
    .select("_id invoiceNumber approval customerId status")
    .lean();
  if (!inv) { console.error(`No invoice carries the external id "${externalId}".`); process.exit(1); }
  const row = await LmsProvision.findOne({ invoiceId: inv._id }).lean();
  return { inv, row };
}

async function check() {
  const externalId = arg("external");
  if (!externalId) { console.error("--check needs --external <id>"); process.exit(1); }
  console.log(`LMS integration: ${lmsConfigured() ? "configured" : "NOT CONFIGURED"}`);

  const { inv, row } = await rowFor(externalId);
  const approval = (inv as { approval?: { state?: string } }).approval?.state ?? "unknown";
  console.log(`\n${inv.invoiceNumber}`);
  console.log(`  approval: ${approval}`);

  if (approval !== "approved") {
    console.log(`\nNot approved yet — nothing is queued until it is. Approve it in finance, then run this again.`);
    return;
  }
  if (!row) {
    console.log(`\nApproved, but nothing was queued. That is the bug this whole exercise was about:`);
    console.log(`  run  bun run backfill:lms  — its first line says whether finance can see its LMS settings.`);
    return;
  }

  console.log(`  provisioning: ${row.status}${row.attempts ? ` after ${row.attempts} attempt(s)` : ""}`);
  if (row.lastError) console.log(`  reason: ${row.lastError}`);
  if (row.status === "sent") {
    console.log(`  LMS course:  ${row.lmsCourseSlug}`);
    console.log(`  LMS user:    ${row.lmsUserId}${row.studentCreated ? " (created by this enrolment)" : " (already existed)"}`);
    console.log(`  sent at:     ${row.sentAt ? new Date(row.sentAt as unknown as string).toISOString() : ""}`);
    console.log(`\nThe student is in the LMS and has been emailed a one-click login link.`);
    console.log(`Nothing sets a password — the link is the credential.`);
  } else if (row.status === "pending") {
    console.log(`\nQueued, not yet delivered. The worker runs on a timer; give it a minute.`);
  }
}

async function cleanup() {
  const externalId = arg("external");
  if (!externalId) { console.error("--cleanup needs --external <id>"); process.exit(1); }
  if (!externalId.startsWith(PREFIX)) {
    console.error(`Refusing: "${externalId}" was not raised by this script.`);
    console.error(`Only ids beginning "${PREFIX}" are removable here — everything else is somebody's sale.`);
    process.exit(1);
  }

  const { inv, row } = await rowFor(externalId);
  const org = await orgId();

  if (row?.lmsUserId) {
    console.log(`\nIn the LMS, still there and not removable from here:`);
    console.log(`  user ${row.lmsUserId}, enrolled on ${row.lmsCourseSlug}, with an order against ${inv.invoiceNumber}.`);
    console.log(`  Delete it in the LMS admin if you want it gone — that needs an admin session, which this has no business holding.`);
  }
  if (row) await LmsProvision.deleteOne({ _id: row._id });

  try {
    await deleteInvoice(org, String(inv._id));
    console.log(`\ndeleted ${inv.invoiceNumber}.`);
  } catch {
    // Only a draft or a voided invoice may be deleted. One that has gone out
    // is a document somebody is holding, so it is voided and kept instead.
    try {
      await voidInvoice(org, String(inv._id));
      console.log(`\n${inv.invoiceNumber} could not be deleted, so it was voided and left in the books.`);
    } catch (err) {
      console.log(`\n${inv.invoiceNumber} could be neither deleted nor voided: ${(err as Error).message}`);
    }
  }

  const customer = await Customer.findById(new Types.ObjectId(String(inv.customerId))).select("name email").lean();
  if (customer) {
    const others = await Invoice.countDocuments({ customerId: inv.customerId });
    if (others === 0) {
      await Customer.deleteOne({ _id: inv.customerId });
      console.log(`removed the test customer ${(customer as { email?: string }).email}.`);
    } else {
      console.log(`left the customer ${(customer as { email?: string }).email} — ${others} other invoice(s) point at them.`);
    }
  }

  console.log(`\nThe invoice number is not returned to the sequence. There is a gap where this was.`);
}

/*
 * A moment before hanging up.
 *
 * Raising an invoice fires the notice to its approvers without waiting for it
 * — right in a server, where the reply should not be held up by an email and
 * the process carries on afterwards. A script has no afterwards: this one
 * disconnected the moment its own work was done, cutting the connection out
 * from under a query that was still running, and reported a MongoClientClosed
 * error for something that had in fact gone fine.
 *
 * There is nothing to await — that is the point of firing it that way — so
 * this gives it a beat. Two seconds against an invoice raised once by hand,
 * and the notice actually reaches the approver rather than dying on the way.
 */
async function settle(ms = 2000) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  await connectDb();
  if (has("create")) { await create(); await settle(); }
  else if (has("check")) await check();
  else if (has("cleanup")) { await cleanup(); await settle(); }
  else {
    console.log("One of --create, --check or --cleanup. See the comment at the top of this file.");
  }
  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
