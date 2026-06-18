import { Types } from "mongoose";
import type {
  ReceivedPaymentsReport,
  AgedReceivablesReport,
  AgedItem,
  AgedTotals,
  InvoiceSummaryReport,
  MadePaymentsReport,
  AgedPayablesReport,
  PLReport,
  PLPeriod,
  PLCategory,
  BalanceSheetReport,
  CashFlowReport,
  VATReport,
  SalesByItemReport,
  ExpenseByCategoryReport,
  CustomerStatementReport,
  CustomerStatementLine,
} from "@delta/shared";
import { Invoice } from "../invoice/invoice.model";
import { Bill } from "../bill/bill.model";
import { Expense } from "../expense/expense.model";

// ── Helpers ───────────────────────────────────────────────────────────────────

function oid(id: string) {
  return new Types.ObjectId(id);
}

function dateOnly(d: Date | undefined): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

function startOf(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function endOf(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999Z`);
}

function daysApart(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

function classifyOverdue(daysOverdue: number) {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "band1to30";
  if (daysOverdue <= 60) return "band31to60";
  if (daysOverdue <= 90) return "band61to90";
  return "band90plus";
}

function sumBand(items: AgedItem[]): number {
  return items.reduce((s, i) => s + i.balanceMinor, 0);
}

function emptyAgedTotals(
  current: AgedItem[],
  band1to30: AgedItem[],
  band31to60: AgedItem[],
  band61to90: AgedItem[],
  band90plus: AgedItem[],
): AgedTotals {
  const c = sumBand(current);
  const b1 = sumBand(band1to30);
  const b2 = sumBand(band31to60);
  const b3 = sumBand(band61to90);
  const b4 = sumBand(band90plus);
  return { current: c, band1to30: b1, band31to60: b2, band61to90: b3, band90plus: b4, grand: c + b1 + b2 + b3 + b4 };
}

// ── 8.1a Received Payments ────────────────────────────────────────────────────

export async function getReceivedPayments(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<ReceivedPaymentsReport> {
  const fromDate = startOf(from);
  const toDate = endOf(to);

  const invoices = await Invoice.find({
    organizationId: oid(orgId),
    "payments.0": { $exists: true },
  })
    .select("payments currency")
    .lean();

  let totalMinor = 0;
  const byPeriodMap = new Map<string, number>();

  for (const inv of invoices) {
    const payments = (inv as unknown as { payments: { amountMinor: number; paidOn: Date }[] }).payments ?? [];
    for (const p of payments) {
      const paidOn = new Date(p.paidOn);
      if (paidOn >= fromDate && paidOn <= toDate) {
        totalMinor += p.amountMinor;
        const key = dateOnly(paidOn).slice(0, 7); // YYYY-MM
        byPeriodMap.set(key, (byPeriodMap.get(key) ?? 0) + p.amountMinor);
      }
    }
  }

  const byPeriod = [...byPeriodMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, amountMinor]) => ({ label, amountMinor }));

  return { from, to, currency, totalMinor, byPeriod };
}

// ── 8.1b Aged Receivables ─────────────────────────────────────────────────────

export async function getAgedReceivables(
  orgId: string,
  currency = "AED",
): Promise<AgedReceivablesReport> {
  const invoices = await Invoice.find({
    organizationId: oid(orgId),
    status: { $in: ["sent", "viewed", "partial", "overdue"] },
    balanceMinor: { $gt: 0 },
  })
    .select("invoiceNumber customerName issueDate dueDate totalMinor balanceMinor")
    .lean();

  const today = new Date();
  const bands = {
    current: [] as AgedItem[],
    band1to30: [] as AgedItem[],
    band31to60: [] as AgedItem[],
    band61to90: [] as AgedItem[],
    band90plus: [] as AgedItem[],
  };

  for (const inv of invoices) {
    const d = inv as unknown as Record<string, unknown>;
    const dueDate = new Date(d.dueDate as Date);
    const daysOverdue = daysApart(dueDate, today);
    const item: AgedItem = {
      id: (inv as unknown as { _id: Types.ObjectId })._id.toString(),
      number: inv.invoiceNumber,
      partyName: inv.customerName,
      issuedDate: dateOnly(d.issueDate as Date),
      dueDate: dateOnly(dueDate),
      totalMinor: (inv.totalMinor as number) ?? 0,
      balanceMinor: (inv.balanceMinor as number) ?? 0,
      daysOverdue,
    };
    const band = classifyOverdue(daysOverdue);
    bands[band].push(item);
  }

  return {
    asOf: dateOnly(today),
    currency,
    ...bands,
    totals: emptyAgedTotals(bands.current, bands.band1to30, bands.band31to60, bands.band61to90, bands.band90plus),
  };
}

// ── 8.1c Invoice Summary ──────────────────────────────────────────────────────

export async function getInvoiceSummary(
  orgId: string,
  from: string,
  to: string,
  groupBy: "salesperson" | "customer" | "tag",
  currency = "AED",
): Promise<InvoiceSummaryReport> {
  const invoices = await Invoice.find({
    organizationId: oid(orgId),
    issueDate: { $gte: startOf(from), $lte: endOf(to) },
    status: { $nin: ["draft", "void"] },
  })
    .select("salespersonId salespersonName customerId customerName tagIds totalMinor balanceMinor amountPaidMinor")
    .lean();

  const groupMap = new Map<string, { id: string; label: string; count: number; totalMinor: number; paidMinor: number; outstandingMinor: number }>();

  for (const inv of invoices) {
    const d = inv as unknown as Record<string, unknown>;
    let id: string;
    let label: string;

    if (groupBy === "salesperson") {
      id = String(d.salespersonId);
      label = (d.salespersonName as string) ?? "Unknown";
    } else if (groupBy === "customer") {
      id = String(d.customerId);
      label = (d.customerName as string) ?? "Unknown";
    } else {
      // tag — one invoice can appear in multiple groups
      const tagIds = (d.tagIds as Types.ObjectId[]) ?? [];
      if (tagIds.length === 0) {
        id = "__untagged";
        label = "Untagged";
      } else {
        for (const tagId of tagIds) {
          const tid = tagId.toString();
          const existing = groupMap.get(tid) ?? { id: tid, label: tid, count: 0, totalMinor: 0, paidMinor: 0, outstandingMinor: 0 };
          existing.count++;
          existing.totalMinor += (inv.totalMinor as number) ?? 0;
          existing.paidMinor += (inv.amountPaidMinor as number) ?? 0;
          existing.outstandingMinor += (inv.balanceMinor as number) ?? 0;
          groupMap.set(tid, existing);
        }
        continue;
      }
    }

    const existing = groupMap.get(id) ?? { id, label, count: 0, totalMinor: 0, paidMinor: 0, outstandingMinor: 0 };
    existing.count++;
    existing.totalMinor += (inv.totalMinor as number) ?? 0;
    existing.paidMinor += (inv.amountPaidMinor as number) ?? 0;
    existing.outstandingMinor += (inv.balanceMinor as number) ?? 0;
    groupMap.set(id, existing);
  }

  return {
    from,
    to,
    currency,
    groupBy,
    items: [...groupMap.values()].sort((a, b) => b.totalMinor - a.totalMinor),
  };
}

// ── 8.2a Made Payments ────────────────────────────────────────────────────────

export async function getMadePayments(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<MadePaymentsReport> {
  const fromDate = startOf(from);
  const toDate = endOf(to);

  const bills = await Bill.find({
    organizationId: oid(orgId),
    "payments.0": { $exists: true },
  })
    .select("vendorId vendorName payments")
    .lean();

  let totalMinor = 0;
  const byVendorMap = new Map<string, { vendorId: string; vendorName: string; amountMinor: number }>();

  for (const bill of bills) {
    const d = bill as unknown as Record<string, unknown>;
    const payments = (d.payments as { amountMinor: number; paidOn: Date }[]) ?? [];
    for (const p of payments) {
      const paidOn = new Date(p.paidOn);
      if (paidOn >= fromDate && paidOn <= toDate) {
        totalMinor += p.amountMinor;
        const vid = String(d.vendorId);
        const existing = byVendorMap.get(vid) ?? { vendorId: vid, vendorName: (d.vendorName as string) ?? "Unknown", amountMinor: 0 };
        existing.amountMinor += p.amountMinor;
        byVendorMap.set(vid, existing);
      }
    }
  }

  return {
    from,
    to,
    currency,
    totalMinor,
    byVendor: [...byVendorMap.values()].sort((a, b) => b.amountMinor - a.amountMinor),
  };
}

// ── 8.2b Aged Payables ────────────────────────────────────────────────────────

export async function getAgedPayables(
  orgId: string,
  currency = "AED",
): Promise<AgedPayablesReport> {
  const bills = await Bill.find({
    organizationId: oid(orgId),
    status: { $in: ["approved", "partially_paid", "overdue"] },
    balanceMinor: { $gt: 0 },
  })
    .select("billNumber vendorName billDate dueDate totalMinor balanceMinor")
    .lean();

  const today = new Date();
  const bands = {
    current: [] as AgedItem[],
    band1to30: [] as AgedItem[],
    band31to60: [] as AgedItem[],
    band61to90: [] as AgedItem[],
    band90plus: [] as AgedItem[],
  };

  for (const bill of bills) {
    const d = bill as unknown as Record<string, unknown>;
    const dueDate = new Date(d.dueDate as Date);
    const daysOverdue = daysApart(dueDate, today);
    const item: AgedItem = {
      id: (bill as unknown as { _id: Types.ObjectId })._id.toString(),
      number: bill.billNumber,
      partyName: bill.vendorName,
      issuedDate: dateOnly(d.billDate as Date),
      dueDate: dateOnly(dueDate),
      totalMinor: (bill.totalMinor as number) ?? 0,
      balanceMinor: (bill.balanceMinor as number) ?? 0,
      daysOverdue,
    };
    const band = classifyOverdue(daysOverdue);
    bands[band].push(item);
  }

  return {
    asOf: dateOnly(today),
    currency,
    ...bands,
    totals: emptyAgedTotals(bands.current, bands.band1to30, bands.band31to60, bands.band61to90, bands.band90plus),
  };
}

// ── 8.3 Profit & Loss ─────────────────────────────────────────────────────────

async function computePL(orgId: string, from: string, to: string): Promise<PLPeriod> {
  const [invoices, bills, expenses] = await Promise.all([
    Invoice.find({
      organizationId: oid(orgId),
      issueDate: { $gte: startOf(from), $lte: endOf(to) },
      status: { $nin: ["draft", "void"] },
    })
      .select("subtotalMinor")
      .lean(),

    Bill.find({
      organizationId: oid(orgId),
      billDate: { $gte: startOf(from), $lte: endOf(to) },
      status: { $nin: ["draft", "voided"] },
    })
      .select("subtotalMinor")
      .lean(),

    Expense.find({
      organizationId: oid(orgId),
      expenseDate: { $gte: startOf(from), $lte: endOf(to) },
      status: { $in: ["approved", "submitted"] },
    })
      .select("category totalMinor")
      .lean(),
  ]);

  const incomeTotal = invoices.reduce((s, i) => s + ((i.subtotalMinor as number) ?? 0), 0);

  const billExpenses = bills.reduce((s, b) => s + ((b.subtotalMinor as number) ?? 0), 0);

  const categoryMap = new Map<string, number>();
  let expenseTotal = 0;
  for (const exp of expenses) {
    const d = exp as unknown as Record<string, unknown>;
    const cat = (d.category as string) ?? "other";
    const amt = (d.totalMinor as number) ?? 0;
    expenseTotal += amt;
    categoryMap.set(cat, (categoryMap.get(cat) ?? 0) + amt);
  }

  const expenseCategories: PLCategory[] = [
    { label: "Supplier bills", amountMinor: billExpenses },
    ...[...categoryMap.entries()].map(([label, amountMinor]) => ({ label, amountMinor })),
  ].filter((c) => c.amountMinor > 0);

  const totalExpenses = billExpenses + expenseTotal;

  return {
    from,
    to,
    income: {
      total: incomeTotal,
      breakdown: [{ label: "Invoice revenue", amountMinor: incomeTotal }],
    },
    expenses: {
      total: totalExpenses,
      breakdown: expenseCategories,
    },
    netProfitMinor: incomeTotal - totalExpenses,
  };
}

export async function getProfitLoss(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<PLReport> {
  const current = await computePL(orgId, from, to);

  // Prior period: same duration shifted back
  const duration = endOf(to).getTime() - startOf(from).getTime();
  const priorTo = new Date(startOf(from).getTime() - 86_400_000);
  const priorFrom = new Date(priorTo.getTime() - duration);
  const prior = await computePL(orgId, dateOnly(priorFrom), dateOnly(priorTo));

  return { ...current, currency, prior };
}

// ── 8.4 Balance Sheet ─────────────────────────────────────────────────────────

export async function getBalanceSheet(
  orgId: string,
  asOf: string,
  currency = "AED",
): Promise<BalanceSheetReport> {
  const asOfDate = endOf(asOf);

  const [receivableAgg, payableAgg] = await Promise.all([
    Invoice.aggregate([
      {
        $match: {
          organizationId: oid(orgId),
          issueDate: { $lte: asOfDate },
          status: { $nin: ["draft", "void"] },
          balanceMinor: { $gt: 0 },
        },
      },
      { $group: { _id: null, total: { $sum: "$balanceMinor" } } },
    ]),
    Bill.aggregate([
      {
        $match: {
          organizationId: oid(orgId),
          billDate: { $lte: asOfDate },
          status: { $nin: ["draft", "voided"] },
          balanceMinor: { $gt: 0 },
        },
      },
      { $group: { _id: null, total: { $sum: "$balanceMinor" } } },
    ]),
  ]);

  const ar = (receivableAgg[0]?.total as number) ?? 0;
  const ap = (payableAgg[0]?.total as number) ?? 0;

  return {
    asOf,
    currency,
    assets: { accountsReceivable: ar, total: ar },
    liabilities: { accountsPayable: ap, total: ap },
    equity: ar - ap,
  };
}

// ── 8.5 Cash Flow ─────────────────────────────────────────────────────────────

export async function getCashFlow(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<CashFlowReport> {
  const fromDate = startOf(from);
  const toDate = endOf(to);

  // Inflows: invoice payments received in period
  const invoices = await Invoice.find({
    organizationId: oid(orgId),
    "payments.0": { $exists: true },
  })
    .select("payments")
    .lean();

  let inflows = 0;
  for (const inv of invoices) {
    const payments = (inv as unknown as { payments: { amountMinor: number; paidOn: Date }[] }).payments ?? [];
    for (const p of payments) {
      const paidOn = new Date(p.paidOn);
      if (paidOn >= fromDate && paidOn <= toDate) inflows += p.amountMinor;
    }
  }

  // Outflows: bill payments + approved expenses in period
  const bills = await Bill.find({
    organizationId: oid(orgId),
    "payments.0": { $exists: true },
  })
    .select("payments")
    .lean();

  let billOutflows = 0;
  for (const bill of bills) {
    const payments = (bill as unknown as { payments: { amountMinor: number; paidOn: Date }[] }).payments ?? [];
    for (const p of payments) {
      const paidOn = new Date(p.paidOn);
      if (paidOn >= fromDate && paidOn <= toDate) billOutflows += p.amountMinor;
    }
  }

  const expenseAgg = await Expense.aggregate([
    {
      $match: {
        organizationId: oid(orgId),
        expenseDate: { $gte: fromDate, $lte: toDate },
        status: { $in: ["approved", "submitted"] },
      },
    },
    { $group: { _id: null, total: { $sum: "$totalMinor" } } },
  ]);
  const expenseOutflows = (expenseAgg[0]?.total as number) ?? 0;

  const outflows = billOutflows + expenseOutflows;

  return {
    from,
    to,
    currency,
    operating: { inflows, outflows, net: inflows - outflows },
    investing: { net: 0 },
    financing: { net: 0 },
    netChange: inflows - outflows,
  };
}

// ── 8.6 VAT Report ────────────────────────────────────────────────────────────

export async function getVATReport(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<VATReport> {
  const [invoices, bills] = await Promise.all([
    Invoice.find({
      organizationId: oid(orgId),
      issueDate: { $gte: startOf(from), $lte: endOf(to) },
      status: { $nin: ["draft", "void"] },
    })
      .select("taxTotalMinor taxBreakdown")
      .lean(),

    Bill.find({
      organizationId: oid(orgId),
      billDate: { $gte: startOf(from), $lte: endOf(to) },
      status: { $nin: ["draft", "voided"] },
    })
      .select("taxTotalMinor")
      .lean(),
  ]);

  const outputTaxMinor = invoices.reduce((s, i) => s + ((i.taxTotalMinor as number) ?? 0), 0);
  const inputTaxMinor = bills.reduce((s, b) => s + ((b.taxTotalMinor as number) ?? 0), 0);

  // Breakdown by tax code from invoice taxBreakdown
  const byCodeOutput = new Map<string, { code: string; rate: number; outputMinor: number; inputMinor: number }>();
  for (const inv of invoices) {
    const breakdown = (inv as unknown as { taxBreakdown?: { code: string; amountMinor: number }[] }).taxBreakdown ?? [];
    for (const tb of breakdown) {
      const existing = byCodeOutput.get(tb.code) ?? { code: tb.code, rate: 0, outputMinor: 0, inputMinor: 0 };
      existing.outputMinor += tb.amountMinor;
      byCodeOutput.set(tb.code, existing);
    }
  }

  return {
    from,
    to,
    currency,
    outputTaxMinor,
    inputTaxMinor,
    netPayableMinor: outputTaxMinor - inputTaxMinor,
    byRate: [...byCodeOutput.values()],
  };
}

// ── 8.7a Sales by Item ────────────────────────────────────────────────────────

export async function getSalesByItem(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<SalesByItemReport> {
  const invoices = await Invoice.find({
    organizationId: oid(orgId),
    issueDate: { $gte: startOf(from), $lte: endOf(to) },
    status: { $nin: ["draft", "void"] },
  })
    .select("lineItems")
    .lean();

  const itemMap = new Map<string, { description: string; qty: number; revenueMinor: number }>();

  for (const inv of invoices) {
    const lines = (inv as unknown as { lineItems: { itemId?: string; description: string; quantity: number; lineSubtotalMinor: number }[] }).lineItems ?? [];
    for (const line of lines) {
      const key = line.itemId ?? `__desc:${line.description}`;
      const existing = itemMap.get(key) ?? { description: line.description, qty: 0, revenueMinor: 0 };
      existing.qty += line.quantity;
      existing.revenueMinor += line.lineSubtotalMinor ?? 0;
      itemMap.set(key, existing);
    }
  }

  const items = [...itemMap.entries()]
    .map(([key, val]) => ({
      itemId: key.startsWith("__desc:") ? null : key,
      description: val.description,
      qty: val.qty,
      revenueMinor: val.revenueMinor,
      avgPriceMinor: val.qty > 0 ? Math.round(val.revenueMinor / val.qty) : 0,
    }))
    .sort((a, b) => b.revenueMinor - a.revenueMinor);

  return {
    from,
    to,
    currency,
    items,
    grandTotalMinor: items.reduce((s, i) => s + i.revenueMinor, 0),
  };
}

// ── 8.7b Expense by Category ──────────────────────────────────────────────────

export async function getExpenseByCategory(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<ExpenseByCategoryReport> {
  const agg = await Expense.aggregate([
    {
      $match: {
        organizationId: oid(orgId),
        expenseDate: { $gte: startOf(from), $lte: endOf(to) },
        status: { $in: ["approved", "submitted"] },
      },
    },
    {
      $group: {
        _id: "$category",
        count: { $sum: 1 },
        totalMinor: { $sum: "$totalMinor" },
      },
    },
    { $sort: { totalMinor: -1 } },
  ]);

  const categories = agg.map((a: { _id: string; count: number; totalMinor: number }) => ({
    category: a._id,
    count: a.count,
    totalMinor: a.totalMinor,
  }));

  return {
    from,
    to,
    currency,
    categories,
    grandTotalMinor: categories.reduce((s, c) => s + c.totalMinor, 0),
  };
}

// ── 8.7c Customer Statement ───────────────────────────────────────────────────

export async function getCustomerStatement(
  orgId: string,
  customerId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<CustomerStatementReport> {
  const CreditNote = (await import("../credit-note/credit-note.model")).CreditNote;

  const [invoices, creditNotes, customer] = await Promise.all([
    Invoice.find({
      organizationId: oid(orgId),
      customerId: oid(customerId),
      issueDate: { $gte: startOf(from), $lte: endOf(to) },
      status: { $nin: ["draft", "void"] },
    })
      .select("invoiceNumber issueDate totalMinor amountPaidMinor payments")
      .lean(),

    CreditNote.find({
      organizationId: oid(orgId),
      customerId: oid(customerId),
      status: { $ne: "voided" },
    })
      .select("creditNoteNumber issueDate totalMinor")
      .lean(),

    (await import("../customer/customer.model")).Customer.findOne({
      _id: oid(customerId),
      organizationId: oid(orgId),
    })
      .select("name")
      .lean(),
  ]);

  const lines: CustomerStatementLine[] = [];

  for (const inv of invoices) {
    const d = inv as unknown as Record<string, unknown>;
    const total = (inv.totalMinor as number) ?? 0;
    lines.push({
      date: dateOnly(d.issueDate as Date),
      type: "invoice",
      number: inv.invoiceNumber,
      description: `Invoice ${inv.invoiceNumber}`,
      debitMinor: total,
      creditMinor: 0,
      balanceMinor: 0, // recalculated below
    });

    const payments = (d.payments as { amountMinor: number; paidOn: Date; reference?: string }[]) ?? [];
    for (const p of payments) {
      lines.push({
        date: dateOnly(new Date(p.paidOn)),
        type: "payment",
        number: (p.reference as string) ?? "",
        description: "Payment received",
        debitMinor: 0,
        creditMinor: p.amountMinor,
        balanceMinor: 0,
      });
    }
  }

  for (const cn of creditNotes) {
    const d = cn as unknown as Record<string, unknown>;
    lines.push({
      date: dateOnly(d.issueDate as Date),
      type: "credit_note",
      number: (d.creditNoteNumber as string) ?? "",
      description: `Credit Note ${String(d.creditNoteNumber ?? "")}`,
      debitMinor: 0,
      creditMinor: (d.totalMinor as number) ?? 0,
      balanceMinor: 0,
    });
  }

  lines.sort((a, b) => a.date.localeCompare(b.date));

  // Running balance
  let balance = 0;
  for (const line of lines) {
    balance += line.debitMinor - line.creditMinor;
    line.balanceMinor = balance;
  }

  const cust = customer as unknown as { name: string } | null;

  return {
    from,
    to,
    currency,
    customerId,
    customerName: cust?.name ?? "Unknown",
    openingBalanceMinor: 0,
    closingBalanceMinor: balance,
    lines,
  };
}
