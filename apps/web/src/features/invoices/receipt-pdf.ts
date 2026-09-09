import { jsPDF } from "jspdf";
import {
  formatMoney,
  formatOrgAddress,
  taxNumberLabel,
  type Invoice,
  type OrganizationSettings,
} from "@delta/shared";

/**
 * A payment receipt as a file.
 *
 * The same reasoning as the invoice: drawn rather than photographed, so the
 * figures in it are real text somebody can copy, and downloading it is one
 * click rather than a print dialog and a decision.
 *
 * Narrower than an invoice on purpose — a receipt says one thing, which is
 * that money arrived. It keeps the shape of the card on screen so the two are
 * recognisably the same document.
 *
 * The organisation's name is written out here where the screen shows a logo.
 * That is not the two drifting apart: a file leaves the application and has to
 * say who issued it, and text is how a drawn page says it.
 */

/** "bank transfer" -> "Bank Transfer". */
function titleCase(v: string): string {
  return v.replace(/\b\w/g, (c) => c.toUpperCase());
}

const W = 210; // A4 portrait, mm
const M = 22;
const LINE = 5;

export function downloadReceiptPdf(opts: {
  invoice: Invoice;
  paymentId: string;
  org?: OrganizationSettings | null;
}): boolean {
  const { invoice, paymentId, org } = opts;
  const payment = invoice.payments.find((p) => p.id === paymentId);
  if (!payment) return false;

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const money = (minor: number) => formatMoney(minor, invoice.currency);
  let y = M;

  // ── Who issued it, and what this is ───────────────────────────────────────
  doc.setFont("helvetica", "bold").setFontSize(18).setTextColor(17);
  doc.text("RECEIPT", W - M, y + 4, { align: "right" });
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(100, 116, 139);
  doc.text(`Ref: ${invoice.invoiceNumber}`, W - M, y + 10, { align: "right" });

  doc.setFont("helvetica", "bold").setFontSize(12).setTextColor(17);
  doc.text(org?.legalName?.trim() || org?.name || "", M, y + 4);

  y += 10;
  doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(71, 85, 105);
  for (const line of formatOrgAddress(org?.address)) {
    doc.text(line, M, y);
    y += LINE - 0.6;
  }
  if (org?.taxRegistrationNumber) {
    doc.text(`${taxNumberLabel(org.taxSystem)}: ${org.taxRegistrationNumber}`, M, y);
    y += LINE - 0.6;
  }

  y += 3;
  doc.setDrawColor(37, 99, 235).setLineWidth(0.8).line(M, y, W - M, y);
  y += 10;

  // ── Who it came from ──────────────────────────────────────────────────────
  doc.setFontSize(8).setTextColor(100, 116, 139);
  doc.text("RECEIVED FROM", M, y);
  y += LINE + 1;
  doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(17);
  doc.text(invoice.customerName, M, y);
  y += 10;

  // ── What arrived ──────────────────────────────────────────────────────────
  const rows: [string, string][] = [
    ["Date", payment.paidOn],
    // Capitalised as the page capitalises it, so the file and the screen read
    // the same rather than "bank transfer" against "Bank Transfer".
    ["Method", titleCase(payment.method.replace(/_/g, " "))],
    ...(payment.accountName ? ([["Account", payment.accountName]] as [string, string][]) : []),
    ...(payment.reference ? ([["Reference", payment.reference]] as [string, string][]) : []),
    ...(payment.notes ? ([["Notes", payment.notes]] as [string, string][]) : []),
  ];

  const boxTop = y;
  const boxHeight = 16 + rows.length * (LINE + 2);
  doc.setFillColor(248, 250, 252).roundedRect(M, boxTop, W - M * 2, boxHeight, 2, 2, "F");

  y += 10;
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(100, 116, 139);
  doc.text("Amount", M + 6, y);
  doc.setFont("helvetica", "bold").setFontSize(16).setTextColor(17);
  doc.text(money(payment.amountMinor), W - M - 6, y + 1, { align: "right" });
  y += LINE + 3;

  for (const [label, value] of rows) {
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(100, 116, 139);
    doc.text(label, M + 6, y);
    doc.setTextColor(55, 65, 81);
    doc.text(String(value), W - M - 6, y, { align: "right" });
    y += LINE + 2;
  }

  y = boxTop + boxHeight + 10;

  // ── Where it leaves the invoice ───────────────────────────────────────────
  doc.setDrawColor(226, 232, 240).setLineWidth(0.3).line(M, y - 5, W - M, y - 5);
  const summary: [string, string, boolean][] = [
    ["Invoice Total", money(invoice.totalMinor), false],
    ["Total Paid", money(invoice.amountPaidMinor), false],
    ["Balance Due", money(invoice.balanceMinor), true],
  ];
  for (const [label, value, strong] of summary) {
    doc.setFont("helvetica", strong ? "bold" : "normal").setFontSize(strong ? 10 : 9);
    doc.setTextColor(strong && invoice.balanceMinor > 0 ? 220 : 100, strong && invoice.balanceMinor > 0 ? 38 : 116, strong && invoice.balanceMinor > 0 ? 38 : 139);
    doc.text(label, M, y);
    doc.setTextColor(strong && invoice.balanceMinor > 0 ? 220 : 17, strong && invoice.balanceMinor > 0 ? 38 : 17, strong && invoice.balanceMinor > 0 ? 38 : 17);
    doc.text(value, W - M, y, { align: "right" });
    y += LINE + 1.5;
  }

  if (invoice.balanceMinor === 0) {
    y += 5;
    doc.setFillColor(240, 253, 244).roundedRect(M, y - 5, W - M * 2, 12, 2, 2, "F");
    doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(22, 163, 74);
    doc.text("PAID IN FULL", W / 2, y + 2.5, { align: "center" });
    y += 14;
  }

  if (org?.branding?.footerText?.trim()) {
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(148, 163, 184);
    doc.text(org.branding.footerText, W / 2, 285, { align: "center" });
  }

  doc.save(`Receipt-${invoice.invoiceNumber}-${payment.paidOn}.pdf`);
  return true;
}
