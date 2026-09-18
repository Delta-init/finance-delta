import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import {
  formatMoney,
  formatOrgAddress,
  getPrintLabels,
  taxNumberLabel,
  displayTaxSplit,
  type Invoice,
  type OrganizationSettings,
  type Customer,
} from "@delta/shared";

/**
 * The invoice as a file, drawn rather than photographed.
 *
 * Downloading used to mean opening the print page and reaching for the
 * browser's own "Save as PDF", which is a dialog and a decision in the middle
 * of what should be one click. Drawn with jsPDF — already here for the list
 * exports — so the text in the file is real text an accountant can select,
 * search and copy, and the file stays small. The alternative, photographing the
 * page onto a canvas, produces a picture of an invoice: nothing in it can be
 * copied and every figure is at the mercy of the screenshot.
 *
 * The cost is that this is a second rendering of the same document, beside the
 * HTML one on screen. They are kept deliberately close in shape and read from
 * exactly the same fields, so a change to one is obvious in the other.
 */

const MARGIN = 14;
const PAGE_W = 210; // A4 portrait, mm
const LINE = 4.4;

interface BankAccount {
  accountName?: string;
  bankName?: string;
  accountNumber?: string;
  iban?: string;
  swift?: string;
  ifsc?: string;
  branch?: string;
}

export function downloadInvoicePdf(opts: {
  invoice: Invoice;
  org?: OrganizationSettings | null;
  customer?: Customer | null;
  bankAccount?: BankAccount | null;
}): void {
  const { invoice, org, customer, bankAccount } = opts;
  const L = getPrintLabels(invoice.locale, org?.taxLabel);
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  const money = (minor: number) => formatMoney(minor, invoice.currency);
  // Rounded so the printed column adds up — see displayTaxSplit.
  const shown = displayTaxSplit(invoice.totalMinor, invoice.taxBreakdown, invoice.currency);

  // "TAX INVOICE" is a claim about the seller: only an organization with a tax
  // registration may head a document that way.
  const registered = Boolean(org?.taxRegistrationNumber?.trim()) && org?.taxSystem !== "none";
  const title = org?.invoiceDefaults?.title?.trim() || (registered ? L.taxInvoice : L.invoice);
  // HSN/SAC is an Indian requirement; an empty column on a dirham invoice reads
  // as something left unfilled.
  const showHsn = org?.taxSystem === "gst";

  let y = MARGIN;

  // ── Header ────────────────────────────────────────────────────────────────
  doc.setFont("helvetica", "bold").setFontSize(18).setTextColor(17);
  doc.text(title, PAGE_W - MARGIN, y + 4, { align: "right" });
  doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(37, 99, 235);
  doc.text(invoice.invoiceNumber, PAGE_W - MARGIN, y + 10, { align: "right" });

  doc.setTextColor(17).setFontSize(11);
  doc.text(org?.legalName?.trim() || org?.name || "", MARGIN, y + 4);

  y += 9;
  doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(71, 85, 105);
  const sellerLines = [
    ...formatOrgAddress(org?.address),
    [org?.phone, org?.email, org?.website].filter((v) => (v ?? "").trim()).join("  ·  "),
  ].filter(Boolean);
  for (const line of sellerLines) {
    doc.text(line, MARGIN, y);
    y += LINE;
  }
  if (org?.taxRegistrationNumber) {
    doc.setTextColor(17).setFont("helvetica", "bold");
    doc.text(`${taxNumberLabel(org.taxSystem)}: ${org.taxRegistrationNumber}`, MARGIN, y);
    doc.setFont("helvetica", "normal").setTextColor(71, 85, 105);
    y += LINE;
  }
  // The registered office, where it differs from the address above.
  const registeredLines = formatOrgAddress(org?.registeredAddress);
  if (registeredLines.length > 0) {
    y += 1.5;
    doc.setTextColor(100, 116, 139);
    doc.text(org?.registeredAddressLabel?.trim() || "Registered office", MARGIN, y);
    y += LINE;
    doc.setTextColor(71, 85, 105);
    for (const line of registeredLines) {
      doc.text(line, MARGIN, y);
      y += LINE;
    }
  }

  y += 2;
  doc.setDrawColor(226, 232, 240).setLineWidth(0.4).line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 6;

  // ── Bill to / meta ────────────────────────────────────────────────────────
  const metaX = PAGE_W / 2 + 6;
  const billTop = y;

  doc.setFontSize(7.5).setTextColor(100, 116, 139);
  doc.text(L.billTo.toUpperCase(), MARGIN, y);
  y += LINE + 0.6;
  doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(17);
  doc.text(invoice.customerName, MARGIN, y);
  y += LINE + 0.6;
  doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(71, 85, 105);
  const billLines = [
    customer?.email,
    customer?.phone,
    ...formatOrgAddress(
      customer
        ? {
            line1: customer.billingAddress.street,
            city: customer.billingAddress.city,
            state: customer.billingAddress.state,
            postcode: customer.billingAddress.zip,
            country: customer.billingAddress.country,
          }
        : null,
    ),
    customer?.vatNumber ? `${taxNumberLabel(org?.taxSystem)}: ${customer.vatNumber}` : "",
  ].filter((v) => (v ?? "").trim());
  for (const line of billLines) {
    doc.text(String(line), MARGIN, y);
    y += LINE;
  }

  // What was actually bought, beside the client.
  let metaY = billTop;
  if (invoice.enrolment) {
    doc.setFontSize(7.5).setTextColor(100, 116, 139);
    doc.text("COURSE", metaX, metaY);
    metaY += LINE + 0.6;
    doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(17);
    doc.text(invoice.enrolment.course, metaX, metaY);
    metaY += LINE + 1;
    doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(71, 85, 105);
    const bits = [
      invoice.enrolment.language ? `Language: ${invoice.enrolment.language}` : "",
      invoice.enrolment.meetingBy ? `Counsellor: ${invoice.enrolment.meetingBy}` : "",
    ].filter(Boolean);
    for (const b of bits) {
      doc.text(b, metaX, metaY);
      metaY += LINE;
    }
    metaY += 1;
  }
  doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(71, 85, 105);
  const meta: [string, string][] = [
    [L.salesperson, invoice.salespersonName],
    ...(invoice.reference ? ([[L.reference, invoice.reference]] as [string, string][]) : []),
    [L.issueDate, invoice.issueDate],
    [L.dueDate, invoice.dueDate],
  ];
  for (const [label, value] of meta) {
    doc.setTextColor(100, 116, 139);
    doc.text(`${label}:`, metaX, metaY);
    doc.setTextColor(17);
    doc.text(String(value ?? ""), PAGE_W - MARGIN, metaY, { align: "right" });
    metaY += LINE;
  }

  y = Math.max(y, metaY) + 4;

  // ── Lines ─────────────────────────────────────────────────────────────────
  const head = showHsn
    ? [["#", L.description, L.hsnSac, L.qty, L.unitPrice, L.tax, L.amount]]
    : [["#", L.description, L.qty, L.unitPrice, L.tax, L.amount]];

  const body = invoice.lineItems.map((l, i) => {
    const taxes = (l.taxes ?? []).map((t) => `${t.code} ${t.rate}%`).join(", ") || "—";
    const base: string[] = [
      String(i + 1),
      l.description,
      String(l.quantity),
      money(l.unitPriceMinor),
      taxes,
      money(l.lineTotalMinor),
    ];
    return showHsn ? [base[0]!, base[1]!, l.hsnSac || "-", ...base.slice(2)] : base;
  });

  autoTable(doc, {
    head,
    body,
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    theme: "grid",
    styles: { fontSize: 8.5, cellPadding: 2, lineColor: [226, 232, 240], textColor: 17 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: "bold", fontSize: 8 },
    columnStyles: showHsn
      ? { 0: { cellWidth: 8 }, 3: { halign: "right" }, 4: { halign: "right" }, 6: { halign: "right" } }
      : { 0: { cellWidth: 8 }, 2: { halign: "right" }, 3: { halign: "right" }, 5: { halign: "right" } },
  });

  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;

  // ── Totals ────────────────────────────────────────────────────────────────
  const totalsX = PAGE_W - MARGIN - 72;
  const row = (label: string, value: string, strong = false) => {
    doc.setFont("helvetica", strong ? "bold" : "normal").setFontSize(strong ? 9.5 : 8.5);
    doc.setTextColor(strong ? 17 : 71, strong ? 17 : 85, strong ? 17 : 105);
    doc.text(label, totalsX, y);
    doc.setTextColor(17);
    doc.text(value, PAGE_W - MARGIN, y, { align: "right" });
    y += LINE + 1;
  };

  row(L.subtotal, money(shown.taxableMinor));
  if (invoice.discountTotalMinor > 0) row(L.discount, `- ${money(invoice.discountTotalMinor)}`);
  for (const t of shown.taxes) row(`${L.tax} (${t.code})`, money(t.amountMinor));
  if (invoice.roundOffMinor !== 0) {
    row(L.roundOff, `${invoice.roundOffMinor < 0 ? "- " : "+ "}${money(Math.abs(invoice.roundOffMinor))}`);
  }
  doc.setDrawColor(226, 232, 240).line(totalsX, y - 2, PAGE_W - MARGIN, y - 2);
  y += 1;
  row(L.total, money(invoice.totalMinor), true);
  if (invoice.amountPaidMinor > 0) row(L.paid, `- ${money(invoice.amountPaidMinor)}`);
  row(L.balanceDue, money(invoice.balanceMinor), true);

  y += 4;

  // ── Tax details, a GST requirement ────────────────────────────────────────
  if (showHsn && invoice.taxBreakdown.length > 0) {
    const rateOf = new Map<string, number>();
    for (const line of invoice.lineItems) {
      for (const t of line.taxes ?? []) if (!rateOf.has(t.code)) rateOf.set(t.code, t.rate);
    }
    const codes = invoice.taxBreakdown.map((t) => t.code);
    const totalRate = codes.reduce((sum, c) => sum + (rateOf.get(c) ?? 0), 0);
    const label =
      totalRate > 0
        ? `GST ${totalRate}% (${codes.map((c) => `${rateOf.get(c) ?? 0}%`).join(" + ")})`
        : codes.join(" + ");

    const paid = invoice.amountPaidMinor;
    const share = (amount: number) =>
      invoice.totalMinor > 0 ? Math.round((paid * amount) / invoice.totalMinor) : 0;
    const received = displayTaxSplit(
      paid,
      invoice.taxBreakdown.map((t) => ({ code: t.code, amountMinor: share(t.amountMinor) })),
      invoice.currency,
    );

    const taxBody: string[][] = [
      [`${label} - invoiced`, money(shown.taxableMinor), ...shown.taxes.map((t) => money(t.amountMinor)), money(invoice.totalMinor)],
    ];
    if (paid > 0) {
      taxBody.push([
        `${label} - received`,
        money(received.taxableMinor),
        ...received.taxes.map((t) => money(t.amountMinor)),
        money(paid),
      ]);
    }
    taxBody.push([
      "Balance",
      ...Array(codes.length + 1).fill(""),
      money(invoice.balanceMinor),
    ]);

    autoTable(doc, {
      head: [["Tax Details", "Taxable", ...codes, "Total"]],
      body: taxBody,
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 1.8, lineColor: [226, 232, 240], textColor: 17 },
      headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: "bold", fontSize: 7.5 },
      columnStyles: Object.fromEntries(
        Array.from({ length: codes.length + 2 }, (_, i) => [i + 1, { halign: "right" as const }]),
      ),
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  }

  // ── Where to pay, and what to know ────────────────────────────────────────
  //
  // One block with two columns rather than three stacked sections. They answer
  // two different questions — where the money goes, and anything else the
  // reader needs — and standing them side by side is both how the document is
  // read and how it fits: an invoice with bank details, a note and terms used
  // to run three headings down the page and push the total off it.
  //
  // Bank details are set right against the divider and the notes left against
  // it, so the two columns lean on the rule between them rather than drifting
  // apart across the page.
  const bankBits = bankAccount
    ? ([
        [L.accountName, bankAccount.accountName],
        ["Bank", bankAccount.bankName],
        [L.accountNumber, bankAccount.accountNumber],
        ["IBAN", bankAccount.iban],
        ["IFSC", bankAccount.ifsc],
        ["Branch", bankAccount.branch],
        ["SWIFT", bankAccount.swift],
      ].filter(([, v]) => (v ?? "").toString().trim()) as [string, string][])
    : [];

  const notes = invoice.notes?.trim() ?? "";
  const terms = invoice.terms?.trim() ?? "";
  const hasBank = bankBits.length > 0;
  const hasSaid = Boolean(notes || terms);

  if (hasBank || hasSaid) {
    const contentW = PAGE_W - MARGIN * 2;
    // Down the middle when both are present; otherwise the one that is there
    // has the whole width, because half a box with nothing beside it reads as
    // something missing.
    const split = MARGIN + (hasBank && hasSaid ? contentW * 0.5 : hasBank ? contentW : 0);
    const PAD = 5;

    const notesW = (hasBank ? PAGE_W - MARGIN - split : contentW) - PAD * 2;
    const noteLines = notes ? (doc.splitTextToSize(notes, notesW) as string[]) : [];
    const termLines = terms ? (doc.splitTextToSize(terms, notesW) as string[]) : [];

    // The taller column decides the box.
    const bankH = hasBank ? LINE + 1.5 + bankBits.length * LINE : 0;
    const saidH = hasSaid
      ? LINE + 1.5 + noteLines.length * LINE + (termLines.length ? 1.5 + termLines.length * (LINE - 0.6) : 0)
      : 0;
    const boxH = Math.max(bankH, saidH) + PAD * 2;

    doc.setDrawColor(226, 232, 240).setLineWidth(0.3);
    doc.rect(MARGIN, y, contentW, boxH);
    if (hasBank && hasSaid) doc.line(split, y, split, y + boxH);

    if (hasBank) {
      // Right-aligned against the divider, as the account details sit on a
      // printed invoice: the labels vary in length and a ragged left edge is
      // less noticeable than a ragged right one next to a rule.
      const right = split - PAD;
      let by = y + PAD + 3;
      doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(51, 65, 85);
      doc.text(L.bankDetails.toUpperCase(), right, by, { align: "right" });
      by += LINE + 1.5;
      doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(71, 85, 105);
      for (const [k, v] of bankBits) {
        doc.text(`${k.toUpperCase()} : ${v}`, right, by, { align: "right" });
        by += LINE;
      }
    }

    if (hasSaid) {
      const left = (hasBank ? split : MARGIN) + PAD;
      let ny = y + PAD + 3;
      doc.setFont("helvetica", "bold").setFontSize(8).setTextColor(51, 65, 85);
      doc.text(L.notes.toUpperCase(), left, ny, { align: "left" });
      ny += LINE + 1.5;

      doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(17);
      for (const line of noteLines) {
        doc.text(line, left, ny);
        ny += LINE;
      }
      // The terms sit under the note, smaller and quieter. They are a condition
      // rather than a message, and giving them their own heading made two
      // paragraphs out of what is read as one.
      if (termLines.length) {
        ny += 1.5;
        doc.setFontSize(7.5).setTextColor(148, 163, 184);
        for (const line of termLines) {
          doc.text(line, left, ny);
          ny += LINE - 0.6;
        }
      }
    }

    y += boxH + 6;
  }

  if (org?.branding?.footerText?.trim()) {
    doc.setFontSize(7.5).setTextColor(148, 163, 184);
    doc.text(org.branding.footerText, PAGE_W / 2, 287, { align: "center" });
  }

  doc.save(`${invoice.invoiceNumber}.pdf`);
}
