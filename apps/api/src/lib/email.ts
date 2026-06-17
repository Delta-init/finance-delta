import { Resend } from "resend";
import { env } from "../config/env";
import { logger } from "./logger";

let client: Resend | null = null;
function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

interface SendResult { id?: string; error?: string }

function invoiceHtml(opts: {
  orgName: string; invoiceNumber: string; customerName: string;
  totalFormatted: string; dueDate: string; footerText?: string; isReminder?: boolean; message?: string;
}): string {
  const heading = opts.isReminder
    ? `Payment Reminder: Invoice ${opts.invoiceNumber}`
    : `Invoice ${opts.invoiceNumber} from ${opts.orgName}`;
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:600px;margin:40px auto;padding:0 24px">
<div style="background:#1d4ed8;border-radius:12px 12px 0 0;padding:24px 28px">
  <span style="color:#fff;font-size:20px;font-weight:700">Δ ${opts.orgName}</span>
</div>
<div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:28px">
  <h2 style="margin:0 0 8px;font-size:18px">${heading}</h2>
  <p style="color:#64748b;margin:0 0 24px">Dear ${opts.customerName},</p>
  ${opts.message ? `<p style="margin:0 0 16px">${opts.message}</p>` : ""}
  ${opts.isReminder
    ? `<p style="margin:0 0 16px">This is a reminder that invoice <strong>${opts.invoiceNumber}</strong> for <strong>${opts.totalFormatted}</strong> is ${opts.dueDate ? `due on <strong>${opts.dueDate}</strong>` : "overdue"}. Please arrange payment at your earliest convenience.</p>`
    : `<p style="margin:0 0 16px">Please find your invoice <strong>${opts.invoiceNumber}</strong> for the amount of <strong>${opts.totalFormatted}</strong>, due on <strong>${opts.dueDate}</strong>.</p>`}
  <div style="background:#f8fafc;border-radius:8px;padding:16px 20px;margin-bottom:24px">
    <div style="display:flex;justify-content:space-between;font-size:13px;color:#64748b"><span>Invoice</span><span style="color:#111;font-weight:600">${opts.invoiceNumber}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:13px;color:#64748b;margin-top:8px"><span>Amount Due</span><span style="color:#111;font-weight:700;font-size:15px">${opts.totalFormatted}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:13px;color:#64748b;margin-top:8px"><span>Due Date</span><span style="color:#111">${opts.dueDate}</span></div>
  </div>
  <p style="color:#64748b;font-size:12px;margin:24px 0 0">${opts.footerText ?? "Thank you for your business."}</p>
</div></body></html>`;
}

export async function sendInvoiceEmail(opts: {
  to: string; orgName: string; invoiceNumber: string; customerName: string;
  totalFormatted: string; dueDate: string; footerText?: string; message?: string;
}): Promise<SendResult> {
  const resend = getClient();
  if (!resend) { logger.warn("RESEND_API_KEY not set — invoice email skipped"); return {}; }
  try {
    const { data, error } = await resend.emails.send({
      from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
      to: [opts.to],
      subject: `Invoice ${opts.invoiceNumber} from ${opts.orgName}`,
      html: invoiceHtml(opts),
    });
    if (error) { logger.warn({ error }, "Resend error"); return { error: error.message }; }
    return { id: data?.id };
  } catch (err) {
    logger.error({ err }, "Failed to send invoice email");
    return { error: "send_failed" };
  }
}

export async function sendReminderEmail(opts: {
  to: string; orgName: string; invoiceNumber: string; customerName: string;
  totalFormatted: string; dueDate: string; footerText?: string; intervalDays: number;
}): Promise<SendResult> {
  const resend = getClient();
  if (!resend) return {};
  const subjectPrefix = opts.intervalDays < 0
    ? `Upcoming payment due in ${Math.abs(opts.intervalDays)} day(s)`
    : `Payment overdue by ${opts.intervalDays} day(s)`;
  try {
    const { data, error } = await resend.emails.send({
      from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
      to: [opts.to],
      subject: `${subjectPrefix}: Invoice ${opts.invoiceNumber}`,
      html: invoiceHtml({ ...opts, isReminder: true }),
    });
    if (error) return { error: error.message };
    return { id: data?.id };
  } catch {
    return { error: "send_failed" };
  }
}
