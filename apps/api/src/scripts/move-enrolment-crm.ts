/**
 * An enrolment moved to the sales CRM that really sold it (the user, 2026-11-24: "this student enrolment by Aparna
 * from Draw, so change it on the finance" — a Draw lead, closed again in the Sales CRM by somebody else as a new
 * lead). The invoice, its money, receipts, VAT and approval stay exactly as they are; what changes is whose sale it is:
 *
 *   - the CRM it came from: external.source and external.externalId → the other CRM and its student there (the id is
 *     given — the one Root's move-close-to-draw.ts makes, so that CRM's status questions find this invoice), and
 *     enrolment.crm;
 *   - the salesperson: the invoice's (their account here; one made with no access when they have none, as intake
 *     does), and the rep the enrolment names (meetingBy, meetingByEmail) — who closed it, for CS Portal;
 *   - the LMS provisioning row's source and crm, so anything sent from it later says the same.
 *
 * Refused: a void invoice, one not from a sales CRM, a course change or balance payment still waiting on it, the
 * other CRM's id already on another invoice, and — with --crm-sale — a CRM commission payout already approved or paid
 * with the old CRM's sale in it. Nothing is sent anywhere: CS Portal and the LMS are put right by their own scripts.
 *
 * Reads and prints only, unless --write; --write saves the invoice's fields as they were first (move-enrolment-crm-
 * <invoice>-<time>.json, read back before anything changes). Run it from apps/api on the server:
 *
 *   bun src/scripts/move-enrolment-crm.ts --invoice IN-00001 --to draw --external-id <id> --salesperson-email <email> \
 *     --salesperson-name "<name>" [--crm-sale <id>] [--org <name|id>] [--write]
 *   bun src/scripts/move-enrolment-crm.ts --undo <file> [--write]
 */
import mongoose, { Types } from "mongoose";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Each sales CRM's intake source — the same one its close sends. */
export const SOURCE_OF_CRM: Record<string, string> = { delta: "crm", remote: "crm", draw: "draw-crm", banglore: "banglore-crm" };
const SALES_SOURCES = new Set(Object.values(SOURCE_OF_CRM));

export interface MoveEnrolmentOpts {
  invoice: string;
  to: string;
  externalId: string;
  salespersonEmail: string;
  salespersonName: string;
  /** The old CRM's commission sale: refused when a payout already approved or paid has it. */
  crmSale?: string;
  org?: string;
  write: boolean;
  /** Where the backup goes (the current directory). */
  dir?: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function moveEnrolmentCrm(o: MoveEnrolmentOpts): Promise<{ lines: string[]; backupFile?: string }> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { Organization } = await import("../modules/organization/organization.model");
  const { User } = await import("../modules/user/user.model");
  const { LmsProvision } = await import("../modules/integrations/lms-provision.model");
  const { BalancePaymentModel: BalancePayment } = await import("../modules/balance-payment/balance-payment.model");
  const { CourseChangeModel: CourseChange } = await import("../modules/course-change/course-change.model");
  const { CrmCommissionPayout } = await import("../modules/crm-commission/crm-commission-payout.model");
  const { ensureCrmSalesperson } = await import("../modules/user/crm-salesperson");
  const lines: string[] = [];
  const say = (s: string) => lines.push(s);

  const to = o.to.trim().toLowerCase();
  const source = SOURCE_OF_CRM[to];
  if (!source) throw new Error(`--to "${o.to}": one of ${Object.keys(SOURCE_OF_CRM).join(", ")}`);
  const externalId = o.externalId.trim();
  if (!/^[a-f0-9]{24}$/i.test(externalId)) throw new Error(`--external-id "${o.externalId}": the student's id in ${to}`);
  const email = o.salespersonEmail.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error(`--salesperson-email "${o.salespersonEmail}" is not an email`);
  const name = o.salespersonName.trim();
  if (!name) throw new Error("--salesperson-name is required");

  let orgFilter: Record<string, unknown> = {};
  if (o.org) {
    const org = Types.ObjectId.isValid(o.org)
      ? await Organization.findById(o.org).lean<any>()
      : await Organization.findOne({ name: new RegExp(`^${esc(o.org)}$`, "i") }).lean<any>();
    if (!org) throw new Error(`No organization ${o.org}`);
    orgFilter = { organizationId: org._id };
  }
  const found = await Invoice.find({ invoiceNumber: o.invoice, ...orgFilter }).lean<any[]>();
  if (!found.length) throw new Error(`No invoice ${o.invoice}`);
  if (found.length > 1) throw new Error(`${o.invoice} is in ${found.length} organizations — say which with --org`);
  const inv = found[0]!;
  const orgId = String(inv.organizationId);

  const refused: string[] = [];
  if (inv.status === "void") refused.push(`${o.invoice} is void`);
  if (!inv.enrolment || !SALES_SOURCES.has(String(inv.external?.source ?? ""))) refused.push(`${o.invoice} is not an enrolment from a sales CRM (source "${inv.external?.source ?? ""}")`);
  const fromCrm = String(inv.enrolment?.crm ?? (inv.external?.source === "draw-crm" ? "draw" : inv.external?.source === "banglore-crm" ? "banglore" : "delta"));
  if (fromCrm === to && inv.external?.externalId === externalId) refused.push(`${o.invoice} is already ${to}'s, student ${externalId}`);
  const taken = await Invoice.findOne({ organizationId: inv.organizationId, "external.source": source, "external.externalId": externalId, _id: { $ne: inv._id } }).select("invoiceNumber").lean<any>();
  if (taken) refused.push(`${taken.invoiceNumber} already is ${to}'s student ${externalId}`);
  const waitingPayments = await BalancePayment.countDocuments({ invoiceId: inv._id, status: "pending" });
  if (waitingPayments) refused.push(`${waitingPayments} balance payment(s) on ${o.invoice} still waiting — decide them first`);
  const waitingChange = await CourseChange.countDocuments({ invoiceId: inv._id, status: "pending" });
  if (waitingChange) refused.push(`a course change on ${o.invoice} is still waiting — decide it first`);
  if (o.crmSale) {
    const payouts = await CrmCommissionPayout.find({ saleIds: o.crmSale.trim() }).select("crm month personName state").lean<any[]>();
    for (const p of payouts) refused.push(`the old sale is in ${p.personName}'s ${p.crm} commission for ${p.month}, already ${p.state}`);
  }

  // The salesperson: an account here as intake finds or makes one (no access).
  const existing = await User.findOne({ email, "memberships.organizationId": inv.organizationId, status: "active" }).select("name").lean<any>();
  const provision = await LmsProvision.findOne({ invoiceId: inv._id }).select("source payload.crm status").lean<any>();

  say(`${o.invoice} · ${inv.customerName} · ${inv.enrolment?.course ?? ""} · ${inv.currency} ${(inv.totalMinor / 100).toFixed(2)} · ${inv.status} · approval ${inv.approval?.state}`);
  say(`  CRM:          ${fromCrm} (${inv.external?.source} ${inv.external?.externalId}) → ${to} (${source} ${externalId})`);
  say(`  salesperson:  ${inv.salespersonName} → ${existing ? existing.name : `${name} (an account made for them, no access)`}`);
  say(`  closed by:    ${inv.enrolment?.meetingBy || "—"} <${inv.enrolment?.meetingByEmail || "—"}> → ${name} <${email}>`);
  say(`  LMS row:      ${provision ? `${provision.source ?? "crm"} / ${provision.payload?.crm ?? "—"} → ${source} / ${to}` : "none"}`);
  say(`  unchanged:    the lines, totals, payments and receipts, VAT, approval, customer`);
  if (refused.length) {
    say(`\nRefused — nothing is written:`);
    for (const r of refused) say(`   ✗ ${r}`);
    throw Object.assign(new Error(lines.join("\n")), { refused: true });
  }
  if (!o.write) return { lines };

  const at = new Date();
  const backupFile = join(o.dir ?? process.cwd(), `move-enrolment-crm-${o.invoice}-${at.toISOString().replace(/[:.]/g, "-")}.json`);
  const before = {
    invoiceId: String(inv._id), invoice: o.invoice, at: at.toISOString(),
    external: { source: inv.external?.source ?? null, externalId: inv.external?.externalId ?? null },
    salespersonId: String(inv.salespersonId), salespersonName: inv.salespersonName,
    enrolment: { crm: inv.enrolment?.crm ?? null, meetingBy: inv.enrolment?.meetingBy ?? null, meetingByEmail: inv.enrolment?.meetingByEmail ?? null },
    provision: provision ? { id: String(provision._id), source: provision.source ?? null, crm: provision.payload?.crm ?? null } : null,
  };
  writeFileSync(backupFile, JSON.stringify(before, null, 2));
  const back = JSON.parse(readFileSync(backupFile, "utf8"));
  if (back.invoiceId !== before.invoiceId || back.external?.externalId !== before.external.externalId) {
    throw new Error(`The backup ${backupFile} didn't read back whole — nothing changed`);
  }

  const person = existing ? { _id: existing._id as Types.ObjectId, name: String(existing.name) } : await ensureCrmSalesperson(orgId, email, name);
  if (!person) throw new Error(`No account could be made for ${email}`);
  await Invoice.updateOne({ _id: inv._id }, {
    $set: {
      "external.source": source, "external.externalId": externalId,
      "enrolment.crm": to, "enrolment.meetingBy": name, "enrolment.meetingByEmail": email,
      salespersonId: person._id, salespersonName: person.name,
    },
  });
  if (provision) await LmsProvision.updateOne({ _id: provision._id }, { $set: { source, ...(provision.payload ? { "payload.crm": to } : {}) } });
  say(`\nDone. ${o.invoice} is ${to}'s now — ${person.name}'s.\nBackup: ${backupFile}\n  bun src/scripts/move-enrolment-crm.ts --undo ${backupFile} --write`);
  return { lines, backupFile };
}

/** Puts the invoice (and its LMS row) back as the backup has it. */
export async function undoMoveEnrolmentCrm(file: string, write: boolean): Promise<string[]> {
  const { Invoice } = await import("../modules/invoice/invoice.model");
  const { LmsProvision } = await import("../modules/integrations/lms-provision.model");
  const b = JSON.parse(readFileSync(file, "utf8"));
  const lines = [`${b.invoice}: back to ${b.external.source} ${b.external.externalId}, ${b.salespersonName}, crm ${b.enrolment.crm ?? "(none)"}${b.provision ? `, its LMS row ${b.provision.source ?? "(none)"} / ${b.provision.crm ?? "(none)"}` : ""}`];
  if (!write) return [...lines, "Nothing written. Add --write to put it back."];
  const set: Record<string, unknown> = {
    "external.source": b.external.source, "external.externalId": b.external.externalId,
    salespersonId: new Types.ObjectId(b.salespersonId), salespersonName: b.salespersonName,
  };
  const unset: Record<string, 1> = {};
  for (const k of ["crm", "meetingBy", "meetingByEmail"] as const) {
    if (b.enrolment[k] === null) unset[`enrolment.${k}`] = 1;
    else set[`enrolment.${k}`] = b.enrolment[k];
  }
  await Invoice.updateOne({ _id: new Types.ObjectId(b.invoiceId) }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  if (b.provision) {
    await LmsProvision.updateOne({ _id: new Types.ObjectId(b.provision.id) }, {
      ...(b.provision.source === null ? { $unset: { source: 1 } } : { $set: { source: b.provision.source } }),
    });
    if (b.provision.crm !== null) await LmsProvision.updateOne({ _id: new Types.ObjectId(b.provision.id), payload: { $type: "object" } }, { $set: { "payload.crm": b.provision.crm } });
  }
  return [...lines, "Done — put back."];
}

if (import.meta.main) {
  const argv = process.argv;
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? "") : ""; };
  const { connectDb } = await import("../config/db");
  await connectDb();
  try {
    const write = argv.includes("--write");
    if (arg("--undo")) {
      for (const l of await undoMoveEnrolmentCrm(arg("--undo"), write)) console.log(l);
    } else {
      const r = await moveEnrolmentCrm({
        invoice: arg("--invoice").toUpperCase(), to: arg("--to"), externalId: arg("--external-id"),
        salespersonEmail: arg("--salesperson-email"), salespersonName: arg("--salesperson-name"),
        crmSale: arg("--crm-sale") || undefined, org: arg("--org") || undefined, write,
      });
      for (const l of r.lines) console.log(l);
      if (!write) console.log("\nNothing written. Check it, then run the same command with --write.");
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  await mongoose.disconnect();
}
