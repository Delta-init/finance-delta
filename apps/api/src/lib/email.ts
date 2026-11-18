import { Resend } from "resend";
import nodemailer, { type Transporter } from "nodemailer";
import { DELTA_LOGO_EMAIL } from "@delta/shared";
import { env } from "../config/env";
import { logger } from "./logger";
import type { MailLog } from "../modules/email-log/email-log.model";

/**
 * How mail leaves this application.
 *
 * There are two ways, and which one is in use depends only on what has been
 * configured. Resend is an HTTP API and takes a key; SMTP is an ordinary mail
 * account. Resend wins when its key is set, because it was here first and an
 * organization that has deliberately configured it should keep it.
 *
 * SMTP exists because that is what most people already have. The variable
 * names are the ones HRMS uses — SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
 * SMTP_SECURE — so a mail account set up once works for both without being
 * entered twice under different spellings.
 *
 * Every send goes through `deliver`, so the three kinds of message cannot
 * drift apart in how they reach a transport or in what they report back.
 */
type Transport = "resend" | "smtp" | "none";

let resendClient: Resend | null = null;
let smtpTransport: Transporter | null = null;

function smtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

/** Which transport will actually be used, without building anything. */
export function activeTransport(): Transport {
  if (env.RESEND_API_KEY) return "resend";
  if (smtpConfigured()) return "smtp";
  return "none";
}

function getResend(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(env.RESEND_API_KEY);
  return resendClient;
}

function getSmtp(): Transporter | null {
  if (!smtpConfigured()) return null;
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ? parseInt(env.SMTP_PORT, 10) : 587,
      // Port 465 is implicit TLS; 587 upgrades with STARTTLS. Saying "secure"
      // on 587 makes the connection hang rather than fail, which is a bad way
      // to find out, so the port decides unless told otherwise.
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : Number(env.SMTP_PORT) === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      // One connection kept open and used for message after message (2026-11-18): signing in again for every email
      // is what made Gmail refuse — "454 4.7.0 Too many login attempts" — after a burst of reminders and receipts.
      pool: true,
      maxConnections: 2,
      maxMessages: 100,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
    });
  }
  return smtpTransport;
}

interface SendResult { id?: string; error?: string; /** Refused for now, and waiting to be sent again (2026-11-18). */ retrying?: boolean }

/**
 * A refusal that passes (2026-11-18): the server's "try again later" (an SMTP 4xx — Gmail's "454 4.7.0 Too many login
 * attempts", a full mailbox's 452) or the connection failing; not a 5xx, which saying it again will not change.
 */
export function isTemporaryMailError(message: string | undefined): boolean {
  const m = String(message ?? "");
  if (!m || /^(no_recipients|not_configured|opted_out|all_recipients_rejected)$/.test(m)) return false;
  if (/\b5\d\d[ -]|\b5\.\d\.\d+\b/.test(m)) return false;
  return /\b4\d\d[ -]|\b4\.\d\.\d+\b|too many login attempts|try again later|temporar|ECONNECTION|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ESOCKET|EDNS|greeting never received|connection closed|timed? ?out/i.test(m);
}

/** Tried again 15, 30 and 45 minutes on: Gmail's lock lifts within the hour. */
const RETRY_AFTER_MIN = [15, 30, 45];

/**
 * One message, out through whichever transport is configured.
 *
 * Always returns rather than throws: mail is a side effect of doing something
 * else — approving a claim, issuing an invoice — and a mail outage must not
 * turn into a failure to do the thing. What it does not do is pretend. A
 * message that did not go returns an error, and the caller is expected to
 * record that rather than report success.
 */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/**
 * Writes the email log entry for one attempt. Never throws and never holds the
 * send up: a log that cannot be written must not cost anybody their email.
 */
export async function logEmail(log: MailLog | undefined, entry: { to: string[]; subject: string; result: SendResult }): Promise<string | null> {
  try {
    const { EmailLog } = await import("../modules/email-log/email-log.model");
    const err = entry.result.error;
    const state = !err ? "sent" : err === "no_recipients" ? "no_address" : err === "not_configured" ? "not_configured" : err === "opted_out" ? "opted_out"
      : entry.result.retrying ? "retrying" : "failed";
    const row = await EmailLog.create({
      organizationId: log?.organizationId || undefined,
      kind: log?.kind ?? "other",
      to: entry.to,
      subject: entry.subject,
      state,
      messageId: entry.result.id ?? "",
      error: state === "sent" ? "" : err ?? "",
      ...(log?.ref ? { ref: log.ref } : {}),
      ...(log?.actorId ? { actorId: log.actorId } : {}),
      actorName: log?.actorName ?? "Automatic",
    });
    return String(row._id);
  } catch (e) {
    logger.warn({ e }, "Could not write the email log");
    return null;
  }
}

async function deliver(opts: {
  to: string[];
  subject: string;
  html: string;
  /** Files to send with it. Both transports take them, in different shapes. */
  attachments?: MailAttachment[];
  /** Where this message goes in the email log. */
  log?: MailLog;
}): Promise<SendResult> {
  // A client with emails turned off gets none of the client's emails (2026-11-16): those addresses are dropped here,
  // where every message passes, and logged as not sent on purpose. Staff messages are never held back by it.
  const off = await optedOut(opts.to, opts.log);
  if (off.length) {
    await logEmail(opts.log, { to: off, subject: opts.subject, result: { error: "opted_out" } });
    const rest = opts.to.filter((t) => t && t.trim() && !off.includes(t.trim().toLowerCase()));
    if (!rest.length) return { error: "opted_out" };
    opts = { ...opts, to: rest };
  }
  const result = await deliverOnce(opts);
  const to = opts.to.filter((t) => t && t.trim());
  // Refused for now (2026-11-18): logged as "Trying again" and kept, to go again in a quarter of an hour.
  if (result.error && isTemporaryMailError(result.error)) result.retrying = true;
  const logId = await logEmail(opts.log, { to, subject: opts.subject, result });
  if (result.retrying) {
    try {
      const { MailOutbox } = await import("../modules/email-log/mail-outbox.model");
      if (!logId) throw new Error("no email log entry");
      await MailOutbox.create({
        logId, to, subject: opts.subject, html: opts.html,
        attachments: (opts.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
        attempts: 1, nextAt: new Date(Date.now() + RETRY_AFTER_MIN[0]! * 60_000), lastError: result.error ?? "",
      });
    } catch (err) {
      result.retrying = false;
      logger.error({ err, to }, "Could not keep the email to try again");
      if (logId) await markLog(logId, { state: "failed" });
    }
  }
  return result;
}

async function markLog(logId: unknown, set: Record<string, unknown>): Promise<void> {
  try {
    const { EmailLog } = await import("../modules/email-log/email-log.model");
    await EmailLog.updateOne({ _id: logId }, { $set: set });
  } catch (e) {
    logger.warn({ e }, "Could not update the email log");
  }
}

/**
 * The emails waiting to go again (2026-11-18): each due one sent once more; sent, its log entry says so (and an
 * invoice's "emailed" with it); refused again for a passing reason, it waits for the next try (15, 30, 45 minutes);
 * otherwise, or after the last try, it is logged as failed. Claimed before it is sent, so two passes never send one
 * twice. Returns what happened, for the worker's log and the checks.
 */
export async function retryQueuedEmails(now = new Date()): Promise<{ sent: number; waiting: number; failed: number }> {
  const { MailOutbox } = await import("../modules/email-log/mail-outbox.model");
  const out = { sent: 0, waiting: 0, failed: 0 };
  const due = await MailOutbox.find({ nextAt: { $lte: now } }).sort({ nextAt: 1 }).limit(50).select("_id").lean();
  for (const { _id } of due) {
    // A lease: another pass that finds it meanwhile leaves it alone.
    const row = await MailOutbox.findOneAndUpdate({ _id, nextAt: { $lte: now } }, { $set: { nextAt: new Date(now.getTime() + 10 * 60_000) } }, { new: true }).lean<any>();
    if (!row) continue;
    const result = await deliverOnce({
      to: row.to, subject: row.subject, html: row.html,
      attachments: (row.attachments ?? []).map((a: any) => ({ filename: a.filename, content: Buffer.from(a.content?.buffer ?? a.content), contentType: a.contentType })),
    });
    const tries = Number(row.attempts) || 1;
    if (!result.error) {
      await markLog(row.logId, { state: "sent", messageId: result.id ?? "", error: "", retries: tries });
      await noteInvoiceEmailed(row.logId, result.id ?? "");
      await MailOutbox.deleteOne({ _id: row._id });
      out.sent++;
    } else if (isTemporaryMailError(result.error) && tries < RETRY_AFTER_MIN.length) {
      // The first send and three more tries: this was try `tries`; the next waits RETRY_AFTER_MIN[tries].
      const after = RETRY_AFTER_MIN[tries]!;
      await MailOutbox.updateOne({ _id: row._id }, { $set: { attempts: tries + 1, nextAt: new Date(now.getTime() + after * 60_000), lastError: result.error } });
      await markLog(row.logId, { error: result.error, retries: tries });
      out.waiting++;
    } else {
      await markLog(row.logId, { state: "failed", error: result.error, retries: tries });
      await MailOutbox.deleteOne({ _id: row._id });
      out.failed++;
    }
  }
  if (due.length) logger.info({ ...out, due: due.length }, "Emails tried again");
  return out;
}

/** An invoice's own email record follows a message that went at the second try. */
async function noteInvoiceEmailed(logId: unknown, messageId: string): Promise<void> {
  try {
    const { EmailLog } = await import("../modules/email-log/email-log.model");
    const log = await EmailLog.findById(logId).select("kind ref").lean<any>();
    if (log?.ref?.type !== "invoice" || !["invoice", "invoice_resend", "invoice_approved"].includes(log.kind)) return;
    const { Invoice } = await import("../modules/invoice/invoice.model");
    await Invoice.updateOne({ _id: log.ref.id }, { $set: { emailDelivery: { state: "sent", at: new Date(), messageId, error: "" }, ...(messageId ? { lastEmailId: messageId } : {}) } });
  } catch (e) {
    logger.warn({ e }, "Could not note the invoice as emailed");
  }
}

/**
 * The emails that reach clients (2026-11-16) — the ones a client's "Receives emails" switch stops: their invoice
 * (issued, approved at a close, sent again), each payment's tax invoice, a course payment's receipt, and the overdue
 * and instalment reminders. Anything else (notices to staff, the salesperson's copy) goes regardless.
 */
export const CLIENT_EMAIL_KINDS = new Set([
  "invoice", "invoice_approved", "invoice_resend", "payment_tax_invoice", "course_payment_receipt", "reminder", "instalment_reminder",
]);

/** Of these addresses, the ones belonging to a client of the organization with emails turned off. Never throws. */
async function optedOut(to: string[], log: MailLog | undefined): Promise<string[]> {
  if (!log || !CLIENT_EMAIL_KINDS.has(log.kind)) return [];
  const addresses = [...new Set(to.map((t) => String(t ?? "").trim().toLowerCase()).filter(Boolean))];
  if (!addresses.length) return [];
  try {
    const { Customer } = await import("../modules/customer/customer.model");
    const rows = await Customer.find({
      email: { $in: addresses }, receivesEmails: false, ...(log.organizationId ? { organizationId: log.organizationId } : {}),
    }).select("email").lean<{ email: string }[]>();
    return [...new Set(rows.map((r) => String(r.email).toLowerCase()))];
  } catch (err) {
    // Unknown is not "off": a lookup that failed must not stop a client's invoice.
    logger.warn({ err }, "Could not check whether a client has emails turned off");
    return [];
  }
}

async function deliverOnce(opts: {
  to: string[];
  subject: string;
  html: string;
  attachments?: MailAttachment[];
}): Promise<SendResult> {
  const recipients = [...new Set(opts.to.filter((t) => t && t.trim()))];
  if (!recipients.length) return { error: "no_recipients" };

  const from = `${env.FROM_NAME} <${env.FROM_EMAIL}>`;

  const resend = getResend();
  if (resend) {
    try {
      const { data, error } = await resend.emails.send({
        from, to: recipients, subject: opts.subject, html: opts.html,
        ...(opts.attachments?.length
          ? {
              attachments: opts.attachments.map((a) => ({
                filename: a.filename,
                // Resend takes base64 over its API; nodemailer takes the bytes.
                content: a.content.toString("base64"),
              })),
            }
          : {}),
      });
      if (error) {
        logger.warn({ error, to: recipients }, "Resend refused the message");
        return { error: error.message };
      }
      return { id: data?.id };
    } catch (err) {
      logger.error({ err, to: recipients }, "Resend threw");
      return { error: "send_failed" };
    }
  }

  const smtp = getSmtp();
  if (smtp) {
    try {
      const info = await smtp.sendMail({
        from, to: recipients.join(", "), subject: opts.subject, html: opts.html,
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      });
      // A server can accept a message for some recipients and refuse others.
      const rejected = (info.rejected ?? []) as string[];
      if (rejected.length === recipients.length) {
        logger.warn({ to: recipients }, "SMTP refused every recipient");
        return { error: "all_recipients_rejected" };
      }
      if (rejected.length) logger.warn({ rejected }, "SMTP refused some recipients");
      return { id: info.messageId };
    } catch (err) {
      // The usual causes are worth having in the log in plain words, because
      // the underlying errors are terse and this is read when mail is broken.
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, to: recipients, host: env.SMTP_HOST }, `SMTP send failed: ${message}`);
      return { error: message };
    }
  }

  logger.warn(
    { subject: opts.subject, to: recipients },
    "No mail transport configured — set RESEND_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS",
  );
  return { error: "not_configured" };
}

/**
 * The masthead every message carries.
 *
 * On a white band, because the wordmark is navy and the previous banner was
 * a solid blue that would have swallowed it. The logo is an absolute URL to
 * object storage and a PNG rather than the webp used on the web — a mail
 * client cannot resolve a relative path, and Outlook renders no webp at all.
 *
 * `logoUrl` is the organization's own where it has set one, so a client
 * billing under their own brand keeps it in the email as well as on the
 * invoice. Alt text carries the name, because a good share of recipients
 * have images turned off and would otherwise see an empty box.
 */
function brandHeader(opts: { orgName?: string; logoUrl?: string }): string {
  const src = opts.logoUrl?.trim() || DELTA_LOGO_EMAIL;
  const name = opts.orgName ?? "Delta Finance";
  return `<div style="padding:20px 28px;border:1px solid #e2e8f0;border-bottom:none;border-radius:12px 12px 0 0;background:#fff">
  <img src="${src}" alt="${name}" width="150" style="height:auto;max-width:150px;display:block;border:0" />
</div>`;
}

/** Enough of the invoice to read without opening anything. */
export interface InvoiceEmailDetail {
  lineItems: { description: string; quantity: number; unitPrice: string; amount: string }[];
  subtotal: string;
  taxes: { label: string; amount: string }[];
  total: string;
  amountPaid?: string;
  balanceDue: string;
  issueDate?: string;
  reference?: string;
}

/** Text from a record, on its way into HTML. */
function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The invoice written out in the message, beside the copy attached to it.
 *
 * The attachment is the document; this is so the message can be read at a
 * glance, on a phone, without downloading anything — which is how most of them
 * are read. A line that says only "your invoice is attached" makes opening the
 * file the price of knowing what it is about.
 *
 * Every value comes from the record already formatted, and is escaped on the
 * way in: a client called "Smith & Sons <Trading>" is ordinary, and it must not
 * be able to close a tag in the mail it is sent.
 */
function detailHtml(d: InvoiceEmailDetail | undefined): string {
  if (!d) return "";
  const cell = "padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:13px";
  const rows = d.lineItems
    .map(
      (l) => `<tr>
  <td style="${cell};color:#111">${esc(l.description)}</td>
  <td style="${cell};text-align:center;color:#475569">${esc(l.quantity)}</td>
  <td style="${cell};text-align:right;color:#475569">${esc(l.unitPrice)}</td>
  <td style="${cell};text-align:right;color:#111;font-weight:600">${esc(l.amount)}</td>
</tr>`,
    )
    .join("");

  const summary = (label: string, value: string, strong = false) =>
    `<tr>
  <td style="padding:4px 10px;text-align:right;font-size:13px;color:#64748b">${esc(label)}</td>
  <td style="padding:4px 10px;text-align:right;font-size:${strong ? "15px" : "13px"};color:#111;font-weight:${strong ? "700" : "600"};white-space:nowrap">${esc(value)}</td>
</tr>`;

  return `<table style="width:100%;border-collapse:collapse;margin:0 0 20px">
  <thead><tr style="background:#f8fafc">
    <th style="${cell};text-align:left;font-size:11px;letter-spacing:.4px;color:#64748b;text-transform:uppercase">Description</th>
    <th style="${cell};text-align:center;font-size:11px;letter-spacing:.4px;color:#64748b;text-transform:uppercase">Qty</th>
    <th style="${cell};text-align:right;font-size:11px;letter-spacing:.4px;color:#64748b;text-transform:uppercase">Rate</th>
    <th style="${cell};text-align:right;font-size:11px;letter-spacing:.4px;color:#64748b;text-transform:uppercase">Amount</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<table style="width:100%;border-collapse:collapse;margin:0 0 24px">
  ${summary("Subtotal", d.subtotal)}
  ${d.taxes.map((t) => summary(t.label, t.amount)).join("")}
  ${summary("Total", d.total, true)}
  ${d.amountPaid ? summary("Paid", d.amountPaid) : ""}
  ${summary("Balance Due", d.balanceDue, true)}
</table>`;
}

function invoiceHtml(opts: {
  orgName: string; invoiceNumber: string; customerName: string;
  totalFormatted: string; dueDate: string; footerText?: string; isReminder?: boolean; message?: string;
  /** The organization's own logo, where it has one. */
  logoUrl?: string;
  detail?: InvoiceEmailDetail;
  /** Said plainly, so nobody hunts for a document that is right there. */
  hasAttachment?: boolean;
}): string {
  /*
   * Everything interpolated below comes from a record somebody typed, and goes
   * into a document made of tags. A client called "Smith & Sons <Trading>" is
   * an ordinary client, and it must not be able to close a tag in the mail it
   * is sent — which it could, until this. The covering note is escaped too: it
   * is written in a plain textarea, so treating it as markup gains nothing and
   * lets a note decide what the rest of the message looks like.
   */
  const invoiceNumber = esc(opts.invoiceNumber);
  const orgName = esc(opts.orgName);
  const customerName = esc(opts.customerName);
  const totalFormatted = esc(opts.totalFormatted);
  const dueDate = esc(opts.dueDate);
  const message = opts.message ? esc(opts.message) : "";
  const footerText = esc(opts.footerText ?? "Thank you for your business.");

  const heading = opts.isReminder
    ? `Payment Reminder: Invoice ${invoiceNumber}`
    : `Invoice ${invoiceNumber} from ${orgName}`;
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:600px;margin:40px auto;padding:0 24px">
${brandHeader({ orgName: opts.orgName, logoUrl: opts.logoUrl })}
<div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:28px">
  <h2 style="margin:0 0 8px;font-size:18px">${heading}</h2>
  <p style="color:#64748b;margin:0 0 24px">Dear ${customerName},</p>
  ${opts.message ? `<p style="margin:0 0 16px">${message}</p>` : ""}
  ${opts.isReminder
    ? `<p style="margin:0 0 16px">This is a reminder that invoice <strong>${invoiceNumber}</strong> for <strong>${totalFormatted}</strong> is ${opts.dueDate ? `due on <strong>${dueDate}</strong>` : "overdue"}. Please arrange payment at your earliest convenience.</p>`
    : `<p style="margin:0 0 16px">Please find your invoice <strong>${invoiceNumber}</strong> for the amount of <strong>${totalFormatted}</strong>, due on <strong>${dueDate}</strong>.</p>`}
  <!-- A table rather than flexbox: Outlook ignores display:flex outright, and
       the three figures used to stack on top of each other there. -->
  <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:8px;margin-bottom:24px">
    <tr><td style="padding:12px 20px 4px;font-size:13px;color:#64748b">Invoice</td>
        <td style="padding:12px 20px 4px;font-size:13px;color:#111;font-weight:600;text-align:right">${invoiceNumber}</td></tr>
    ${opts.detail?.issueDate ? `<tr><td style="padding:4px 20px;font-size:13px;color:#64748b">Issued</td><td style="padding:4px 20px;font-size:13px;color:#111;text-align:right">${esc(opts.detail.issueDate)}</td></tr>` : ""}
    ${opts.detail?.reference ? `<tr><td style="padding:4px 20px;font-size:13px;color:#64748b">Reference</td><td style="padding:4px 20px;font-size:13px;color:#111;text-align:right">${esc(opts.detail.reference)}</td></tr>` : ""}
    <tr><td style="padding:4px 20px;font-size:13px;color:#64748b">Amount Due</td>
        <td style="padding:4px 20px;font-size:15px;color:#111;font-weight:700;text-align:right">${opts.detail?.balanceDue ?? opts.totalFormatted}</td></tr>
    <tr><td style="padding:4px 20px 12px;font-size:13px;color:#64748b">Due Date</td>
        <td style="padding:4px 20px 12px;font-size:13px;color:#111;text-align:right">${dueDate}</td></tr>
  </table>

  ${detailHtml(opts.detail)}

  ${opts.hasAttachment ? `<p style="color:#64748b;font-size:12px;margin:0 0 8px">A PDF copy of this invoice is attached.</p>` : ""}
  <p style="color:#64748b;font-size:12px;margin:24px 0 0">${footerText}</p>
</div></body></html>`;
}

/**
 * A plain notice to somebody inside the business, rather than to a customer.
 *
 * The invoice mail above is a document going out; this is a nudge going in —
 * "a payroll is waiting", "a payment did not land". Same channel, different
 * voice, so it gets its own shell rather than being squeezed into a template
 * that opens with "Dear customer".
 */
function noticeHtml(opts: { title: string; lines: string[]; actionLabel?: string; actionUrl?: string; logoUrl?: string; logoName?: string }): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:600px;margin:40px auto;padding:0 24px">
${brandHeader({ logoUrl: opts.logoUrl, orgName: opts.logoName })}
<div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:28px">
  <h2 style="margin:0 0 16px;font-size:18px">${opts.title}</h2>
  ${opts.lines.map((l) => `<p style="margin:0 0 12px;color:#334155">${l}</p>`).join("")}
  ${opts.actionUrl && opts.actionLabel
    ? `<p style="margin:24px 0 0"><a href="${opts.actionUrl}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600">${opts.actionLabel}</a></p>`
    : ""}
</div></body></html>`;
}

/**
 * Tell a group of colleagues something happened.
 *
 * Sent to each address separately rather than as one message with many
 * recipients, so nobody learns who else is on the payroll distribution list.
 */
export async function sendNotice(opts: {
  to: string[];
  subject: string;
  title: string;
  lines: string[];
  actionLabel?: string;
  actionUrl?: string;
  log?: MailLog;
  /** A document to go with it — a payment's tax invoice. */
  attachments?: MailAttachment[];
  /** Another logo at its head than Delta's, and the name for it (2026-11-18: DGO Academy on a Tabby DGO receipt). */
  logoUrl?: string;
  logoName?: string;
}): Promise<{ sent: number; skipped?: string }> {
  const recipients = [...new Set(opts.to.filter(Boolean))];
  if (!recipients.length) return { sent: 0, skipped: "no_recipients" };

  // One at a time, so a notice to five approvers does not put their addresses
  // in each other's To line.
  const html = noticeHtml(opts);
  let sent = 0;
  let lastError: string | undefined;
  for (const to of recipients) {
    const { error } = await deliver({ to: [to], subject: opts.subject, html, attachments: opts.attachments, log: opts.log ?? { kind: "notice" } });
    if (error) lastError = error;
    else sent++;
  }
  return sent > 0 ? { sent } : { sent: 0, skipped: lastError ?? "send_failed" };
}

export async function sendInvoiceEmail(opts: {
  to: string; orgName: string; invoiceNumber: string; customerName: string;
  totalFormatted: string; dueDate: string; footerText?: string; message?: string;
  /** The organization's own logo, where it has one. */
  logoUrl?: string;
  /** The invoice written out in the message, beside the copy attached. */
  detail?: InvoiceEmailDetail;
  /**
   * The invoice itself, as a file.
   *
   * The message has always described the invoice — number, amount, due date —
   * and left the reader to log in somewhere for the document. An invoice is a
   * document; sending a paragraph about one and keeping the document back is
   * most of the way to sending nothing.
   */
  attachments?: MailAttachment[];
  log?: MailLog;
}): Promise<SendResult> {
  return deliver({
    to: [opts.to],
    subject: `Invoice ${opts.invoiceNumber} from ${opts.orgName}`,
    html: invoiceHtml({ ...opts, hasAttachment: Boolean(opts.attachments?.length) }),
    attachments: opts.attachments,
    log: opts.log ?? { kind: "invoice" },
  });
}

export async function sendReminderEmail(opts: {
  to: string; orgName: string; invoiceNumber: string; customerName: string;
  totalFormatted: string; dueDate: string; footerText?: string; intervalDays: number;
  /** The organization's own logo, where it has one. */
  logoUrl?: string;
  /** The invoice written out in the message, beside the copy attached. */
  detail?: InvoiceEmailDetail;
  /** The invoice being chased, so the reader has it to hand. */
  attachments?: MailAttachment[];
  log?: MailLog;
}): Promise<SendResult> {
  const subjectPrefix = opts.intervalDays < 0
    ? `Upcoming payment due in ${Math.abs(opts.intervalDays)} day(s)`
    : `Payment overdue by ${opts.intervalDays} day(s)`;
  return deliver({
    to: [opts.to],
    subject: `${subjectPrefix}: Invoice ${opts.invoiceNumber}`,
    html: invoiceHtml({ ...opts, isReminder: true, hasAttachment: Boolean(opts.attachments?.length) }),
    attachments: opts.attachments,
    log: opts.log ?? { kind: "reminder" },
  });
}

/**
 * A partial enrolment's next instalment, 3, 2 and 1 day before it is due
 * (the user, 2026-10-11): to the client, balance-aware — what is left to pay,
 * for which course, by when, the invoice, and how to pay or ask. Sent as
 * "Delta Finance" like every other mail from here.
 */
export interface InstalmentReminderContent {
  to: string;
  orgName: string;
  customerName: string;
  course: string;
  invoiceNumber: string;
  /** The balance, formatted with its currency. */
  balance: string;
  total: string;
  paid: string;
  /** "YYYY-MM-DD" and how it is read. */
  dueDate: string;
  dueDateLong: string;
  daysBefore: number;
  contactEmail?: string;
  contactPhone?: string;
  /** The account to pay into, where the organization has one on its invoices. */
  bank?: { name?: string; accountName?: string; accountNumber?: string; iban?: string; swift?: string } | null;
  logoUrl?: string;
  footerText?: string;
  log?: MailLog;
}

/** When the instalment is due, said for a reminder `daysBefore` days ahead — 0 today, negative overdue (2026-10-16). */
export function instalmentWhen(daysBefore: number): string {
  if (daysBefore > 1) return `is due in ${daysBefore} days`;
  if (daysBefore === 1) return "is due tomorrow";
  if (daysBefore === 0) return "is due today";
  const late = -daysBefore;
  return `is overdue by ${late} day${late === 1 ? "" : "s"}`;
}

export function instalmentReminderSubject(c: Pick<InstalmentReminderContent, "course" | "dueDateLong" | "daysBefore">): string {
  return c.daysBefore < 0
    ? `Your instalment for ${c.course} is overdue (due on ${c.dueDateLong})`
    : `Your next instalment for ${c.course} ${instalmentWhen(c.daysBefore)} (${c.dueDateLong})`;
}

function instalmentReminderHtml(c: InstalmentReminderContent): string {
  const row = (label: string, value: string, strong = false) =>
    `<tr><td style="padding:4px 20px;font-size:13px;color:#64748b">${esc(label)}</td><td style="padding:4px 20px;font-size:${strong ? "15px" : "13px"};color:#111;font-weight:${strong ? "700" : "600"};text-align:right">${esc(value)}</td></tr>`;
  const bank = c.bank && (c.bank.accountNumber || c.bank.iban)
    ? `<p style="margin:0 0 8px">To pay by bank transfer:</p>
  <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:8px;margin-bottom:16px">
    ${c.bank.name ? row("Bank", c.bank.name) : ""}
    ${c.bank.accountName ? row("Account name", c.bank.accountName) : ""}
    ${c.bank.accountNumber ? row("Account number", c.bank.accountNumber) : ""}
    ${c.bank.iban ? row("IBAN", c.bank.iban) : ""}
    ${c.bank.swift ? row("SWIFT", c.bank.swift) : ""}
  </table>
  <p style="margin:0 0 16px;font-size:13px;color:#475569">Please quote invoice <strong>${esc(c.invoiceNumber)}</strong> as the reference.</p>`
    : "";
  const contact = [c.contactEmail && `email <a href="mailto:${esc(c.contactEmail)}">${esc(c.contactEmail)}</a>`, c.contactPhone && `call ${esc(c.contactPhone)}`]
    .filter(Boolean).join(" or ");
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:600px;margin:40px auto;padding:0 24px">
${brandHeader({ orgName: c.orgName, logoUrl: c.logoUrl })}
<div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:28px">
  <h2 style="margin:0 0 8px;font-size:18px">Your ${c.daysBefore < 0 ? "instalment" : "next instalment"} ${esc(instalmentWhen(c.daysBefore))}</h2>
  <p style="color:#64748b;margin:0 0 24px">Dear ${esc(c.customerName)},</p>
  <p style="margin:0 0 16px">${c.daysBefore < 0
    ? `Your instalment of <strong>${esc(c.balance)}</strong> for <strong>${esc(c.course)}</strong> was due on <strong>${esc(c.dueDateLong)}</strong> and is still unpaid. Please pay it as soon as you can.`
    : `Your next instalment of <strong>${esc(c.balance)}</strong> for <strong>${esc(c.course)}</strong> is due on <strong>${esc(c.dueDateLong)}</strong>.`}</p>
  <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:8px;margin-bottom:24px">
    ${row("Invoice", c.invoiceNumber)}
    ${row("Course fee", c.total)}
    ${row("Paid so far", c.paid)}
    ${row("Balance due", c.balance, true)}
    ${row("Due date", c.dueDateLong)}
  </table>
  ${bank}
  <p style="margin:0 0 16px">If you have already paid, thank you — please reply with your receipt so we can record it. To pay, or for any question about your fees, ${contact ? `${contact}, or ` : ""}reply to this email or speak to your Customer Success manager.</p>
  <p style="color:#64748b;font-size:12px;margin:24px 0 0">${esc(c.footerText || "Thank you for studying with us.")}</p>
</div></body></html>`;
}

export async function sendInstalmentReminderEmail(c: InstalmentReminderContent): Promise<SendResult> {
  return deliver({
    to: [c.to],
    subject: instalmentReminderSubject(c),
    html: instalmentReminderHtml(c),
    log: c.log ?? { kind: "instalment_reminder" },
  });
}
