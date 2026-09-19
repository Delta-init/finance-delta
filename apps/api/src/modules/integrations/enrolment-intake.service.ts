import { Types } from "mongoose";
import { inboundEnrolmentLanguage } from "@delta/shared";
import type { InboundEnrolmentInput, InboundEnrolmentResult } from "@delta/shared";
import { AppError } from "../../lib/http";
import { logger } from "../../lib/logger";
import { Invoice } from "../invoice/invoice.model";
import { Item } from "../inventory/item.model";
import { User } from "../user/user.model";
import { findOrCreateCustomer } from "../customer/customer.service";
import { createInvoice } from "../invoice/invoice.service";

/**
 * Taking an enrolment from another system.
 *
 * The CRM closes a lead and the same enrolment has to exist here, because this
 * is where the money lives — the tax, the payments, the approval. Typing it
 * twice is how the two ended up disagreeing about what a student owes.
 *
 * Everything that is this system's rule stays this system's: the currency, the
 * tax, the invoice number, and whether accounts must approve it. The caller
 * says who bought what and what they paid, and nothing more.
 */

/**
 * Nothing here refuses an enrolment for being incomplete.
 *
 * A sale that cannot be recorded because somebody has not mapped a course, or
 * because a new rep has no account here yet, is a worse outcome than an invoice
 * that needs a moment of tidying. So the gaps are collected and returned, and
 * accounts sees them on the invoice.
 */
function flag(flags: string[], message: string): void {
  if (!flags.includes(message)) flags.push(message);
}

/** Who to bill this against when the CRM's rep is not somebody here. */
async function resolveSalesperson(
  orgId: string,
  input: InboundEnrolmentInput,
  flags: string[],
): Promise<{ _id: Types.ObjectId; name: string }> {
  if (input.salespersonEmail) {
    const user = await User.findOne({
      email: input.salespersonEmail.trim().toLowerCase(),
      "memberships.organizationId": orgId,
      status: "active",
    }).select("name");
    if (user) return { _id: user._id as Types.ObjectId, name: user.name as string };
    flag(
      flags,
      `${input.salespersonName || input.salespersonEmail} has no account here — reassign this invoice to the right person.`,
    );
  }

  /*
   * The fallback: whoever can approve. Not an invented account — the invoice
   * has to belong to somebody real for the approval queue to reach anybody, and
   * an administrator is who will be sorting the attribution out anyway.
   */
  const { Role } = await import("../role/role.model");
  const roles = await Role.find({
    organizationId: new Types.ObjectId(orgId),
    $or: [{ permissions: "invoice:write" }, { permissions: "*" }],
  }).select("_id");
  const fallback = await User.findOne({
    status: "active",
    memberships: {
      $elemMatch: { organizationId: new Types.ObjectId(orgId), roleId: { $in: roles.map((r) => r._id) } },
    },
  })
    .select("name")
    .sort({ createdAt: 1 });

  if (!fallback) {
    throw new AppError(
      "CONFLICT",
      "This organization has nobody who can be given the invoice. Add a user who can approve invoices.",
    );
  }
  return { _id: fallback._id as Types.ObjectId, name: fallback.name as string };
}

/**
 * The catalogue item behind the course, where the caller has mapped one.
 *
 * A course that has not been mapped still enrols; the line simply carries the
 * name and the price the caller sent. The alternative — refusing until somebody
 * finishes the mapping — stops a sale for a piece of housekeeping.
 */
async function resolveItem(
  orgId: string,
  input: InboundEnrolmentInput,
  flags: string[],
): Promise<string | undefined> {
  if (!input.course.itemId) {
    flag(flags, `"${input.course.name}" is not mapped to a catalogue item.`);
    return undefined;
  }
  const item = await Item.findOne({
    _id: new Types.ObjectId(input.course.itemId),
    organizationId: new Types.ObjectId(orgId),
  }).select("_id");
  if (!item) {
    flag(flags, `The catalogue item sent for "${input.course.name}" does not exist here.`);
    return undefined;
  }
  return String(item._id);
}

/**
 * The tax this organization charges on a sale.
 *
 * Resolved here rather than taken from the caller. The CRM has no idea what VAT
 * applies and should not: an enrolment arriving from it must be taxed exactly
 * as one typed into the enrolment form, or the same course bills two different
 * totals depending on which screen it came through.
 */
async function defaultSalesTaxes(orgId: string): Promise<{ code: string; rate: number }[]> {
  const { Organization } = await import("../organization/organization.model");
  const org = await Organization.findById(orgId).select("taxRates").lean();
  const rates = ((org as Record<string, unknown> | null)?.taxRates ?? []) as {
    code: string;
    rate: number;
    isDefault?: boolean;
    appliesTo?: string;
  }[];
  return rates
    .filter((r) => r.isDefault && r.appliesTo !== "purchases")
    .map((r) => ({ code: r.code, rate: r.rate }));
}

export async function intakeEnrolment(
  orgId: string,
  input: InboundEnrolmentInput,
): Promise<InboundEnrolmentResult> {
  /*
   * Already done?
   *
   * Checked before anything is created, because the case this exists for is a
   * caller that timed out and retried — the invoice was made, the answer was
   * lost. Billing that client again is the one outcome worth real care.
   */
  const existing = await Invoice.findOne({
    organizationId: new Types.ObjectId(orgId),
    "external.source": input.source,
    "external.externalId": input.externalId,
  }).select("invoiceNumber customerId external");
  if (existing) {
    return {
      invoiceId: String(existing._id),
      invoiceNumber: existing.invoiceNumber as string,
      customerId: String(existing.customerId),
      duplicate: true,
      flags: ((existing as unknown as { external?: { flags?: string[] } }).external?.flags) ?? [],
    };
  }

  const flags: string[] = [];
  const salesperson = await resolveSalesperson(orgId, input, flags);
  const itemId = await resolveItem(orgId, input, flags);

  /*
   * Teach the item its LMS course, once.
   *
   * The approval reads the mapping off the item, and somebody has to put it
   * there. A caller that already knows which course this is can save them the
   * job — but only for an item that has no mapping yet: finance's own answer
   * wins, because whoever set it there did so deliberately and a sales system
   * should not be able to move where an approved enrolment sends students.
   */
  if (itemId && input.course.lmsCourseSlug?.trim()) {
    const { Item } = await import("../inventory/item.model");
    await Item.updateOne(
      { _id: new Types.ObjectId(itemId), organizationId: orgId, $or: [{ lmsCourseSlug: "" }, { lmsCourseSlug: { $exists: false } }] },
      { $set: { lmsCourseSlug: input.course.lmsCourseSlug.trim() } },
    ).catch(() => {});
  }

  // Found or made, and never overwritten — a student enrolling on a second
  // course is the ordinary case, not a duplicate.
  const { customer } = await findOrCreateCustomer(orgId, {
    name: input.customer.name,
    email: input.customer.email,
    phone: input.customer.phone,
  } as never);

  const enrolledOn = input.enrolledOn?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const taxes = await defaultSalesTaxes(orgId);

  /*
   * Created through the ordinary path, not by writing a document.
   *
   * That is what gives it the organization's tax, its numbering, its currency
   * and — because the caller is not a person who can see the whole ledger —
   * an approval state of pending. A CRM enrolment reaches accounts exactly as a
   * counsellor-typed one does.
   */
  const invoice = await createInvoice(
    orgId,
    {
      customerId: customer.id,
      salespersonId: String(salesperson._id),
      issueDate: enrolledOn,
      dueDate: enrolledOn,
      reference: `${input.source}:${input.externalId}`,
      notes: input.notes ?? "",
      /*
       * The fee the CRM sends is what the client agreed to pay, the same as
       * the figure a counsellor types into the enrolment form — so the tax
       * comes out of it rather than on top. Adding it here instead would bill
       * the same course two different totals depending on which screen the
       * enrolment came through, which is the thing `defaultSalesTaxes` exists
       * to prevent.
       */
      taxInclusive: true,
      lineItems: [
        {
          description: input.course.name,
          quantity: 1,
          unitPriceMinor: input.course.amountMinor,
          taxes,
          ...(itemId ? { itemId } : {}),
          // The CRM's own code for the course, where it keeps one. Left off
          // when it does not, so the mapped item's code or the organization's
          // default decides instead.
          ...(input.course.hsnSac?.trim() ? { hsnSac: input.course.hsnSac.trim() } : {}),
        },
      ],
      enrolment: {
        course: input.course.name,
        modeOfStudy: input.modeOfStudy,
        /*
         * Not flagged: a flag on every single record from one caller is noise,
         * rather than something anybody can act on. The approval panel shows
         * the value, so it says plainly that nobody chose one.
         */
        language: inboundEnrolmentLanguage(input.language),
        meetingBy: input.salespersonName ?? "",
        declaredPaidMinor: input.declaredPaidMinor,
        declaredPaymentMethod: input.declaredPaymentMethod,
      },
    } as never,
    // Scoped, so createInvoice treats it the way it treats a counsellor: the
    // enrolment starts pending and cannot go to the client unapproved.
    { all: false, userId: String(salesperson._id) },
  );

  await Invoice.updateOne(
    { _id: new Types.ObjectId(invoice.id) },
    {
      $set: {
        external: { source: input.source, externalId: input.externalId, flags },
        // The receipt the counsellor took at the close, recorded as an
        // ordinary attachment so it appears where an approver already looks
        // for one — beside the invoice they are deciding about, rather than in
        // whatever system it was collected in.
        ...(input.receipt
          ? {
              attachments: [
                {
                  name: input.receipt.name,
                  url: input.receipt.url,
                  key: input.receipt.key,
                  size: input.receipt.size,
                  mimeType: input.receipt.mimeType,
                  uploadedAt: new Date(),
                },
              ],
            }
          : {}),
      },
    },
  );

  logger.info(
    { orgId, source: input.source, externalId: input.externalId, invoice: invoice.invoiceNumber, flags },
    "Enrolment taken from an external system",
  );

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    customerId: customer.id,
    duplicate: false,
    flags,
  };
}
