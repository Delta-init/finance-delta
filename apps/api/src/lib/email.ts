import { Resend } from "resend";
import nodemailer, { type Transporter } from "nodemailer";
import { DELTA_LOGO_EMAIL } from "@delta/shared";
import { env } from "../config/env";
import { logger } from "./logger";

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
    });
  }
  return smtpTransport;
}

interface SendResult { id?: string; error?: string }

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

async function deliver(opts: {
  to: string[];
  subject: string;
  html: string;
  /** Files to send with it. Both transports take them, in different shapes. */
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
function noticeHtml(opts: { title: string; lines: string[]; actionLabel?: string; actionUrl?: string }): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:600px;margin:40px auto;padding:0 24px">
${brandHeader({})}
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
}): Promise<{ sent: number; skipped?: string }> {
  const recipients = [...new Set(opts.to.filter(Boolean))];
  if (!recipients.length) return { sent: 0, skipped: "no_recipients" };

  // One at a time, so a notice to five approvers does not put their addresses
  // in each other's To line.
  const html = noticeHtml(opts);
  let sent = 0;
  let lastError: string | undefined;
  for (const to of recipients) {
    const { error } = await deliver({ to: [to], subject: opts.subject, html });
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
}): Promise<SendResult> {
  return deliver({
    to: [opts.to],
    subject: `Invoice ${opts.invoiceNumber} from ${opts.orgName}`,
    html: invoiceHtml({ ...opts, hasAttachment: Boolean(opts.attachments?.length) }),
    attachments: opts.attachments,
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
}): Promise<SendResult> {
  const subjectPrefix = opts.intervalDays < 0
    ? `Upcoming payment due in ${Math.abs(opts.intervalDays)} day(s)`
    : `Payment overdue by ${opts.intervalDays} day(s)`;
  return deliver({
    to: [opts.to],
    subject: `${subjectPrefix}: Invoice ${opts.invoiceNumber}`,
    html: invoiceHtml({ ...opts, isReminder: true, hasAttachment: Boolean(opts.attachments?.length) }),
    attachments: opts.attachments,
  });
}
