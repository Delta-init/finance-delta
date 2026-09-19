import { z } from "zod";
import { tagRefSchema } from "./tag.schema";
import { emiDetailInputSchema, emiDetailSchema } from "./emi.schema";

export const TAX_CODES = ["VAT", "GST", "CGST", "SGST", "IGST", "TDS", "WHT", "NONE"] as const;
export type TaxCode = (typeof TAX_CODES)[number];

export const PAYMENT_METHODS = [
  "cash",
  "bank_transfer",
  "cheque",
  "card",
  "easebuzz_emi",
  "tabby",
  // Buy-now-pay-later and the instalment portal, beside Tabby: from the
  // counsellor's side these are the same act — the client pays a third party
  // and the enrolment is settled — so they belong in the same list rather than
  // being typed as "other" and losing which one it was.
  "tamara",
  "billexpro",
  // A rupee account an AED business also collects into. Its own method rather
  // than a note on a bank transfer, because "which account did it land in" is
  // the question somebody asks when the two are reconciled separately.
  "inr_bank_account",
  "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * What each payment method is called on screen.
 *
 * Here rather than in each screen that shows one: four copies had drifted, and
 * a method missing from a copy renders as a raw slug like "easebuzz_emi" in
 * front of a client.
 */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  card: "Card",
  easebuzz_emi: "Easebuzz EMI",
  tabby: "Tabby",
  tamara: "Tamara",
  billexpro: "Smart Invoice / BillExPro",
  inr_bank_account: "INR Bank Account",
  other: "Other",
};

/** The label, or the slug tidied up, for a method stored before this list grew. */
export function paymentMethodLabel(method: string | undefined | null): string {
  if (!method) return "";
  return (
    PAYMENT_METHOD_LABELS[method as PaymentMethod] ??
    method.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "paid",
  "partial",
  "overdue",
  "void",
] as const;
export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const RECURRING_FREQUENCIES = ["weekly", "monthly", "annually"] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

// ── Input schemas ──

export const taxInputSchema = z.object({
  code: z.string().min(1).max(20),
  rate: z.coerce.number().min(0).max(100),
});
export type TaxInput = z.infer<typeof taxInputSchema>;

export const invoiceLineInputSchema = z.object({
  description: z.string().min(1, "Description required").max(300),
  quantity: z.coerce.number().positive("Qty must be > 0"),
  unitPriceMinor: z.coerce.number().int().min(0),
  discountPct: z.coerce.number().min(0).max(100).optional().default(0),
  taxes: z.array(taxInputSchema).optional().default([]),
  itemId: z.string().optional(),
  warehouseId: z.string().optional(),
  /** HSN (goods) or SAC (services) code. Required on Indian tax invoices. */
  hsnSac: z.string().max(20).optional().default(""),
});
export type InvoiceLineInput = z.infer<typeof invoiceLineInputSchema>;

export const progressInputSchema = z.object({
  contractDescription: z.string().min(1).max(500),
  contractValueMinor: z.coerce.number().int().min(0),
  stageName: z.string().min(1).max(200),
  stageNumber: z.coerce.number().int().min(1),
  pctOfContract: z.coerce.number().min(0).max(100),
});
export type ProgressInput = z.infer<typeof progressInputSchema>;

export const recurringInputSchema = z.object({
  frequency: z.enum(RECURRING_FREQUENCIES),
  startDate: z.string().min(1, "Start date required"),
  endDate: z.string().optional(),
  isActive: z.boolean().default(true),
});
export type RecurringInput = z.infer<typeof recurringInputSchema>;

export const recordPaymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountMinor: z.coerce.number().int().positive("Amount must be positive"),
  paidOn: z.string().min(1, "Payment date is required"),
  reference: z.string().max(200).optional().default(""),
  notes: z.string().max(1000).optional().default(""),
  accountName: z.string().max(100).optional().default(""),
  /** Transaction/bank charges deducted, in minor units (informational). */
  chargesMinor: z.coerce.number().int().min(0).optional().default(0),
  /** Easebuzz EMI details — sent only when method is "easebuzz_emi". */
  emi: emiDetailInputSchema.optional(),
  /** Populated by the server after uploading to R2 — not accepted from client directly. */
  proofUrl: z.string().url().optional(),
  proofKey: z.string().optional(),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const PRINT_LOCALES = ["en", "ar", "fr"] as const;
export type PrintLocale = (typeof PRINT_LOCALES)[number];


/**
 * What somebody enrolled in, on the invoice that bills it.
 *
 * These are the details a counsellor takes at the point of sale and the
 * institute later counts by — how many enrolled on a course, in which
 * language, run by whom. The notes field would hold them but nothing could
 * count them, which is why they are fields.
 *
 * One enrolment to one invoice, so this sits on the invoice rather than on a
 * line; a second course later is a second invoice. The academic counsellor is
 * the invoice's salesperson, which is already pinned to whoever raised it.
 *
 * Its presence is also what marks an invoice as needing approval. Invoices
 * accounts raise themselves are untouched by any of this.
 */
export const MODES_OF_STUDY = ["online", "offline", "hybrid"] as const;
export type ModeOfStudy = (typeof MODES_OF_STUDY)[number];

/**
 * Whether an invoice may go out.
 *
 * Held on the invoice rather than inside its enrolment, because the question is
 * about the invoice: somebody who only sees their own records should not put a
 * document in front of a client unchecked, and that is as true of a plain
 * invoice a salesperson raised as of an enrolment.
 *
 * `not_required` is the ordinary case — an invoice raised by somebody trusted
 * with the organization's whole ledger has nobody to be approved by.
 */
export const INVOICE_APPROVALS = ["not_required", "pending", "approved", "returned"] as const;
export type InvoiceApproval = (typeof INVOICE_APPROVALS)[number];

/**
 * Whether this state stops the invoice reaching a client.
 *
 * One definition because three places ask it — the server refusing a send, the
 * detail screen deciding what to offer, and the approval panel. Two of them
 * disagreeing would mean offering a button that only ever produces a refusal.
 */
export function approvalBlocksSending(state: InvoiceApproval | undefined | null): boolean {
  return state === "pending" || state === "returned";
}

/**
 * Whether this state stops the person who raised the invoice from changing it.
 *
 * Approval is worth nothing if the figures can move afterwards: what an
 * approver approved has to be what the invoice says. Waiting counts too, since
 * editing then changes what somebody is part-way through reading.
 *
 * Sent back stays open — correcting it is exactly what should happen next — and
 * this says nothing about accounts, who can always make a correction.
 */
export function approvalBlocksEditing(state: InvoiceApproval | undefined | null): boolean {
  return state === "pending" || state === "approved";
}

export const invoiceApprovalSchema = z.object({
  state: z.enum(INVOICE_APPROVALS).default("not_required"),
  byId: z.string().optional(),
  byName: z.string().optional(),
  at: z.string().optional(),
  returnedReason: z.string().optional(),
  submittedAt: z.string().optional(),
});
export type InvoiceApprovalState = z.infer<typeof invoiceApprovalSchema>;

export const enrolmentInputSchema = z.object({
  course: z.string().trim().min(1, "Course is required").max(120),
  modeOfStudy: z.enum(MODES_OF_STUDY),
  language: z.string().trim().min(1, "Language is required").max(60),
  /** Who ran the meeting, where that is not the counsellor raising this. */
  /**
   * Who ran the meeting, chosen from the organization rather than typed.
   *
   * A typed name cannot be counted: "Yamini", "yamini" and "Yamini K" are three
   * people as far as any report is concerned. The id is what is picked and the
   * name is kept beside it, so the record still reads properly after somebody
   * leaves and their account goes.
   */
  meetingById: z.string().optional(),
  /** One unit of the organization's currency buys this many of the invoice's. */
  exchangeRate: z.coerce.number().positive().optional(),
  meetingBy: z.string().trim().max(120).optional().default(""),
  /**
   * What the counsellor says was collected, and how.
   *
   * Declared, not recorded: the counsellor took the money but does not mark
   * the invoice paid — an approver does that after checking. Holding it here
   * means the approver sees what to expect instead of being told separately,
   * and the two figures can be compared.
   */
  declaredPaidMinor: z.number().int().min(0).optional().default(0),
  declaredPaymentMethod: z.enum(PAYMENT_METHODS).optional(),
});
export type EnrolmentInput = z.infer<typeof enrolmentInputSchema>;

/**
 * What an enrolment is, with no say in whether it may be sent — that moved to
 * the invoice, which is the thing being approved.
 */
export const enrolmentSchema = enrolmentInputSchema;
export type Enrolment = z.infer<typeof enrolmentSchema>;

export const createInvoiceSchema = z.object({
  customerId: z.string().min(1, "Select a customer"),
  salespersonId: z.string().min(1, "Salesperson is required"),
  /** Present when this invoice bills an enrolment. */
  enrolment: enrolmentInputSchema.optional(),
  reference: z.string().max(200).optional().default(""),
  issueDate: z.string().min(1, "Issue date is required"),
  dueDate: z.string().min(1, "Due date is required"),
  currency: z.string().min(3).max(3).optional(),
  notes: z.string().max(2000).optional().default(""),
  terms: z.string().max(2000).optional().default(""),
  tagIds: z.array(z.string()).optional().default([]),
  lineItems: z.array(invoiceLineInputSchema).min(1, "Add at least one line item"),
  progress: progressInputSchema.nullable().optional(),
  recurring: recurringInputSchema.nullable().optional(),
  locale: z.enum(PRINT_LOCALES).optional().default("en"),
  exchangeRate: z.coerce.number().positive().optional(),
  taxInclusive: z.boolean().optional().default(false),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const updateInvoiceSchema = createInvoiceSchema.partial();
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;

// ── Output DTOs ──

export const taxBreakdownSchema = z.object({
  code: z.string(),
  rate: z.number(),
  amountMinor: z.number(),
});
export type TaxBreakdown = z.infer<typeof taxBreakdownSchema>;

export const paymentSchema = z.object({
  id: z.string(),
  method: z.enum(PAYMENT_METHODS),
  amountMinor: z.number(),
  paidOn: z.string(),
  reference: z.string(),
  notes: z.string(),
  accountName: z.string(),
  chargesMinor: z.number().default(0),
  emi: emiDetailSchema.optional(),
  proofUrl: z.string().optional(),
  createdAt: z.string(),
});
export type Payment = z.infer<typeof paymentSchema>;

export const invoiceLineSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unitPriceMinor: z.number(),
  discountPct: z.number(),
  itemId: z.string().optional(),
  warehouseId: z.string().optional(),
  hsnSac: z.string().default(""),
  taxes: z.array(taxBreakdownSchema),
  lineSubtotalMinor: z.number(),
  discountMinor: z.number(),
  taxableMinor: z.number(),
  taxTotalMinor: z.number(),
  lineTotalMinor: z.number(),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

export const invoiceAttachmentSchema = z.object({
  name: z.string(),
  url: z.string(),
  key: z.string().optional(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
  uploadedAt: z.string().optional(),
});
export type InvoiceAttachment = z.infer<typeof invoiceAttachmentSchema>;

export const invoiceEmailDeliverySchema = z.object({
  state: z.enum(["sent", "failed", "no_address", "not_configured"]),
  at: z.string(),
  messageId: z.string().default(""),
  error: z.string().default(""),
});
export type InvoiceEmailDelivery = z.infer<typeof invoiceEmailDeliverySchema>;

export const invoiceSchema = z.object({
  id: z.string(),
  invoiceNumber: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  salespersonId: z.string(),
  enrolment: enrolmentSchema.optional(),
  approval: invoiceApprovalSchema,
  /**
   * What became of the last attempt to email this invoice.
   *
   * Absent on invoices nobody has tried to send. "Sent" as a status means
   * somebody pressed Send; this means the message actually left.
   */
  emailDelivery: invoiceEmailDeliverySchema.optional(),
  attachments: z.array(invoiceAttachmentSchema).default([]),
  salespersonName: z.string(),
  reference: z.string(),
  status: invoiceStatusSchema,
  issueDate: z.string(),
  dueDate: z.string(),
  currency: z.string(),
  lineItems: z.array(invoiceLineSchema),
  subtotalMinor: z.number(),
  discountTotalMinor: z.number(),
  taxBreakdown: z.array(z.object({ code: z.string(), amountMinor: z.number() })),
  taxTotalMinor: z.number(),
  /** Adjustment folded into totalMinor to reach a whole unit of currency. */
  roundOffMinor: z.number().default(0),
  totalMinor: z.number(),
  /** The total in the organization's own currency, at the rate on the invoice. */
  baseTotalMinor: z.number().default(0),
  amountPaidMinor: z.number(),
  balanceMinor: z.number(),
  notes: z.string(),
  terms: z.string(),
  tags: z.array(tagRefSchema).default([]),
  branding: z
    .object({
      logoUrl: z.string().optional(),
      primaryColor: z.string().optional(),
      footerText: z.string().optional(),
    })
    .optional(),
  progress: z
    .object({
      contractDescription: z.string(),
      contractValueMinor: z.number(),
      stageName: z.string(),
      stageNumber: z.number(),
      pctOfContract: z.number(),
    })
    .nullable()
    .optional(),
  recurring: z
    .object({
      frequency: z.enum(RECURRING_FREQUENCIES),
      startDate: z.string(),
      endDate: z.string().optional(),
      nextRunAt: z.string(),
      isActive: z.boolean(),
    })
    .nullable()
    .optional(),
  payments: z.array(paymentSchema).default([]),
  sourceQuoteId: z.string().optional(),
  locale: z.string().optional(),
  exchangeRate: z.number().optional(),
  taxInclusive: z.boolean().default(false),
  createdAt: z.string(),
});
export type Invoice = z.infer<typeof invoiceSchema>;


/**
 * What somebody is owed and what is waiting on them, for the screen they land
 * on when they sign in.
 *
 * Broken out per currency rather than added up. An organization can bill in
 * more than one, and a single figure summing dirhams to rupees is not a smaller
 * truth — it is a wrong number, which is exactly the mistake that put a payroll
 * run's rupees under an AED heading.
 */
export const moneyByCurrencySchema = z.object({
  currency: z.string(),
  minor: z.number(),
  count: z.number(),
});
export type MoneyByCurrency = z.infer<typeof moneyByCurrencySchema>;

export const invoiceSummarySchema = z.object({
  /** Sent and still owed, whether or not it is late. */
  outstanding: z.array(moneyByCurrencySchema),
  /** The subset of the above that is past its due date. */
  overdue: z.array(moneyByCurrencySchema),
  /**
   * Taken by the counsellor but not yet recorded against the invoice. Somebody
   * else acts on this — it is here so they stop chasing a client who has paid.
   */
  collectedNotRecorded: z.array(moneyByCurrencySchema),
  /** Their own submissions that have not been decided yet. */
  awaitingApproval: z.number(),
  /** Sent back to them, which is the one that needs them today. */
  returned: z.number(),
});
export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

/** Sending an invoice back needs a reason whoever raised it can act on. */
export const returnInvoiceSchema = z.object({
  reason: z.string().trim().min(1, "Say what needs correcting").max(300),
});
export type ReturnInvoiceInput = z.infer<typeof returnInvoiceSchema>;

/**
 * An enrolment arriving from another system — today, the sales CRM when a lead
 * is closed.
 *
 * Deliberately narrow. The caller says who the client is, what they bought and
 * what they paid; everything else — the tax, the currency, the invoice number,
 * whether it needs approving — is decided here, because those are this system's
 * rules and a caller that could set them could quietly bypass them.
 */
export const inboundEnrolmentSchema = z.object({
  /**
   * The caller's own id for this enrolment.
   *
   * The idempotency key. A retry after a timeout must find the invoice that was
   * already made rather than billing the client a second time.
   */
  externalId: z.string().min(1).max(120),
  /** What the caller calls itself, for the audit trail. */
  source: z.string().min(1).max(40).default("crm"),

  customer: z.object({
    name: z.string().min(1).max(120),
    email: z.string().email(),
    phone: z.string().min(1).max(30),
  }),

  course: z.object({
    name: z.string().min(1).max(160),
    /** The finance inventory item, where the caller has mapped one. */
    itemId: z.string().optional(),
    amountMinor: z.number().int().min(0),
    /**
     * The code this course is sold under, where the calling system keeps one.
     *
     * A GST invoice needs it per line, and the CRM is where somebody who knows
     * the course sets it. Falls back to the mapped item's code, then to the
     * organization's default, so a caller that knows nothing about tax codes
     * still produces a valid invoice.
     */
    hsnSac: z.string().max(20).optional(),
  }),

  /** Who sold it, by email. Attributed to the fallback when unknown here. */
  salespersonEmail: z.string().email().optional(),
  /** Their name in the calling system, kept whether or not they have an account here. */
  salespersonName: z.string().max(120).optional(),

  enrolledOn: z.string().optional(),
  declaredPaidMinor: z.number().int().min(0).default(0),
  declaredPaymentMethod: z.enum(PAYMENT_METHODS).optional(),
  modeOfStudy: z.enum(MODES_OF_STUDY).default("online"),
  language: z.string().max(60).default(""),
  /**
   * Proof the money was taken, as a file already in storage.
   *
   * A reference rather than the bytes. The calling system writes the receipt
   * to the same bucket this one reads, so what crosses is a key — the file is
   * attached to the invoice without being uploaded twice, and there is one
   * object rather than two copies that can drift apart.
   *
   * Which means the URL is trusted, and is only as trustworthy as the caller:
   * this endpoint is already authenticated per integration client, and a
   * client that can raise invoices can be believed about where it put a file.
   */
  receipt: z
    .object({
      name: z.string().max(200),
      url: z.string().url(),
      key: z.string().max(500),
      size: z.number().int().min(0).optional(),
      mimeType: z.string().max(100).optional(),
    })
    .optional(),
  notes: z.string().max(2000).optional(),
});
export type InboundEnrolmentInput = z.infer<typeof inboundEnrolmentSchema>;

/**
 * The language to record for an enrolment that arrived from another system.
 *
 * The two schemas disagree on purpose. A caller cannot be made to supply a
 * language it does not hold — the CRM has no such field, and refusing the
 * payload would lose the sale — but an enrolment invoice must carry one, both
 * here (`enrolmentInputSchema`) and in the database. This is the bridge, and it
 * lives beside both schemas so the next person changing either can see it.
 */
export function inboundEnrolmentLanguage(language: string | undefined): string {
  return (language ?? "").trim() || "Not specified";
}

/** What the caller gets back, and stores against its own record. */
export const inboundEnrolmentResultSchema = z.object({
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  customerId: z.string(),
  /** True when this call found an invoice a previous one had already made. */
  duplicate: z.boolean(),
  /**
   * Anything accounts should look at: an unmatched course, a salesperson with
   * no account here. The enrolment is created regardless — a sale is never
   * blocked by a mapping somebody has not got round to.
   */
  flags: z.array(z.string()),
});
export type InboundEnrolmentResult = z.infer<typeof inboundEnrolmentResultSchema>;
