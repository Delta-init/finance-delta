import { Types } from "mongoose";
import { Invoice } from "../invoice/invoice.model";
import { Bill } from "../bill/bill.model";
import { Expense } from "../expense/expense.model";
import { categoryNameMap } from "../expense-category/expense-category.service";

function oid(id: string) { return new Types.ObjectId(id); }
function startOf(d: Date) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function endOf(d: Date) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999)); }

export interface DashboardStats {
  currency: string;
  kpi: {
    revenueMtd: number;
    revenueLastMonth: number;
    revenueTrend: number; // percent change
    receivables: number;
    payables: number;
    netProfitMtd: number;
    netProfitLastMonth: number;
    overdueCount: number;
    overdueAmount: number;
  };
  cashflow: Array<{ month: string; inflowMinor: number; outflowMinor: number }>;
  recentInvoices: Array<{
    id: string;
    number: string;
    customerName: string;
    status: string;
    dueDate: string;
    totalMinor: number;
    balanceMinor: number;
  }>;
  topCustomers: Array<{ name: string; revenueMinor: number; invoiceCount: number }>;
  expenseBreakdown: Array<{ category: string; totalMinor: number }>;
  aging: { current: number; band1to30: number; band31to60: number; band61to90: number; band90plus: number; total: number };
}

export async function getDashboardStats(orgId: string, currency = "AED"): Promise<DashboardStats> {
  const now = new Date();

  // Current month bounds
  const mtdStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const mtdEnd = endOf(now);

  // Last month bounds
  const lmStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lmEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));

  // 6 months back for cashflow
  const sixMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));

  const [
    revMtdAgg, revLmAgg,
    receivablesAgg, payablesAgg,
    expMtdAgg, expLmAgg,
    overdueAgg,
    recentInvs,
    topCustAgg,
    expByCatAgg,
    cashflowInvs, cashflowBills,
    agingInvs,
  ] = await Promise.all([
    // Revenue MTD
    Invoice.aggregate([
      { $match: { organizationId: oid(orgId), issueDate: { $gte: mtdStart, $lte: mtdEnd }, status: { $nin: ["draft", "void"] } } },
      { $group: { _id: null, total: { $sum: "$subtotalMinor" } } },
    ]),
    // Revenue last month
    Invoice.aggregate([
      { $match: { organizationId: oid(orgId), issueDate: { $gte: lmStart, $lte: lmEnd }, status: { $nin: ["draft", "void"] } } },
      { $group: { _id: null, total: { $sum: "$subtotalMinor" } } },
    ]),
    // Outstanding receivables
    Invoice.aggregate([
      { $match: { organizationId: oid(orgId), status: { $in: ["sent", "viewed", "partial", "overdue"] }, balanceMinor: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$balanceMinor" } } },
    ]),
    // Outstanding payables
    Bill.aggregate([
      { $match: { organizationId: oid(orgId), status: { $in: ["approved", "partially_paid", "overdue"] }, balanceMinor: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$balanceMinor" } } },
    ]),
    // Expenses MTD (bills + expense records)
    Promise.all([
      Bill.aggregate([
        { $match: { organizationId: oid(orgId), billDate: { $gte: mtdStart, $lte: mtdEnd }, status: { $nin: ["draft", "voided"] } } },
        { $group: { _id: null, total: { $sum: "$subtotalMinor" } } },
      ]),
      Expense.aggregate([
        { $match: { organizationId: oid(orgId), expenseDate: { $gte: mtdStart, $lte: mtdEnd }, status: { $in: ["approved", "submitted"] } } },
        { $group: { _id: null, total: { $sum: "$totalMinor" } } },
      ]),
    ]),
    // Expenses last month
    Promise.all([
      Bill.aggregate([
        { $match: { organizationId: oid(orgId), billDate: { $gte: lmStart, $lte: lmEnd }, status: { $nin: ["draft", "voided"] } } },
        { $group: { _id: null, total: { $sum: "$subtotalMinor" } } },
      ]),
      Expense.aggregate([
        { $match: { organizationId: oid(orgId), expenseDate: { $gte: lmStart, $lte: lmEnd }, status: { $in: ["approved", "submitted"] } } },
        { $group: { _id: null, total: { $sum: "$totalMinor" } } },
      ]),
    ]),
    // Overdue invoices
    Invoice.aggregate([
      { $match: { organizationId: oid(orgId), dueDate: { $lt: now }, status: { $in: ["sent", "viewed", "partial"] }, balanceMinor: { $gt: 0 } } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$balanceMinor" } } },
    ]),
    // Recent invoices
    Invoice.find({ organizationId: oid(orgId), status: { $ne: "void" } })
      .sort({ createdAt: -1 }).limit(7)
      .select("invoiceNumber customerName status dueDate totalMinor balanceMinor")
      .lean(),
    // Top customers (last 6 months)
    Invoice.aggregate([
      { $match: { organizationId: oid(orgId), issueDate: { $gte: sixMonthsAgo }, status: { $nin: ["draft", "void"] } } },
      { $group: { _id: "$customerName", revenue: { $sum: "$subtotalMinor" }, count: { $sum: 1 } } },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
    // Expense by category (last 3 months)
    Expense.aggregate([
      { $match: { organizationId: oid(orgId), expenseDate: { $gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)) }, status: { $in: ["approved", "submitted"] } } },
      { $group: { _id: "$category", total: { $sum: "$totalMinor" } } },
      { $sort: { total: -1 } },
      { $limit: 6 },
    ]),
    // Cashflow: invoice payments received in last 6 months
    Invoice.find({ organizationId: oid(orgId), "payments.0": { $exists: true } }).select("payments").lean(),
    // Cashflow: bill payments in last 6 months
    Bill.find({ organizationId: oid(orgId), "payments.0": { $exists: true } }).select("payments").lean(),
    // Aging: outstanding invoices
    Invoice.find({
      organizationId: oid(orgId),
      status: { $in: ["sent", "viewed", "partial", "overdue"] },
      balanceMinor: { $gt: 0 },
    }).select("dueDate balanceMinor").lean(),
  ]);

  const revMtd = (revMtdAgg[0]?.total as number) ?? 0;
  const revLm = (revLmAgg[0]?.total as number) ?? 0;
  const revTrend = revLm > 0 ? Math.round(((revMtd - revLm) / revLm) * 100) : 0;
  const receivables = (receivablesAgg[0]?.total as number) ?? 0;
  const payables = (payablesAgg[0]?.total as number) ?? 0;

  type AggResult = { total?: number }[];
  const [billsMtd, expsMtd] = expMtdAgg as [AggResult, AggResult];
  const [billsLm, expsLm] = expLmAgg as [AggResult, AggResult];
  const totalExpMtd = (billsMtd[0]?.total ?? 0) + (expsMtd[0]?.total ?? 0);
  const totalExpLm = (billsLm[0]?.total ?? 0) + (expsLm[0]?.total ?? 0);

  // Cashflow by month (last 6 months)
  const monthMap = new Map<string, { inflowMinor: number; outflowMinor: number }>();
  const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    monthMap.set(key, { inflowMinor: 0, outflowMinor: 0 });
  }
  for (const inv of cashflowInvs) {
    const payments = (inv as unknown as { payments: { amountMinor: number; paidOn: Date }[] }).payments ?? [];
    for (const p of payments) {
      const d = new Date(p.paidOn);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      if (monthMap.has(key)) monthMap.get(key)!.inflowMinor += p.amountMinor;
    }
  }
  for (const bill of cashflowBills) {
    const payments = (bill as unknown as { payments: { amountMinor: number; paidOn: Date }[] }).payments ?? [];
    for (const p of payments) {
      const d = new Date(p.paidOn);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      if (monthMap.has(key)) monthMap.get(key)!.outflowMinor += p.amountMinor;
    }
  }
  const cashflow = [...monthMap.entries()].map(([key, val]) => {
    const [y, m] = key.split("-").map(Number);
    return { month: `${MONTH_LABELS[m! - 1]} ${y}`, ...val };
  });

  // Aging
  const aging = { current: 0, band1to30: 0, band31to60: 0, band61to90: 0, band90plus: 0, total: 0 };
  for (const inv of agingInvs) {
    const d = inv as unknown as { dueDate: Date; balanceMinor: number };
    const days = Math.floor((now.getTime() - new Date(d.dueDate).getTime()) / 86_400_000);
    const bal = d.balanceMinor ?? 0;
    aging.total += bal;
    if (days <= 0) aging.current += bal;
    else if (days <= 30) aging.band1to30 += bal;
    else if (days <= 60) aging.band31to60 += bal;
    else if (days <= 90) aging.band61to90 += bal;
    else aging.band90plus += bal;
  }

  const dateOnly = (d: Date | undefined) => d ? new Date(d).toISOString().slice(0, 10) : "";

  const catNameMap = await categoryNameMap(orgId);

  return {
    currency,
    kpi: {
      revenueMtd: revMtd,
      revenueLastMonth: revLm,
      revenueTrend: revTrend,
      receivables,
      payables,
      netProfitMtd: revMtd - totalExpMtd,
      netProfitLastMonth: revLm - totalExpLm,
      overdueCount: (overdueAgg[0]?.count as number) ?? 0,
      overdueAmount: (overdueAgg[0]?.total as number) ?? 0,
    },
    cashflow,
    recentInvoices: recentInvs.map((inv) => {
      const d = inv as unknown as { _id: { toString(): string }; invoiceNumber: string; customerName: string; status: string; dueDate: Date; totalMinor: number; balanceMinor: number };
      return {
        id: d._id.toString(),
        number: d.invoiceNumber,
        customerName: d.customerName,
        status: d.status,
        dueDate: dateOnly(d.dueDate),
        totalMinor: d.totalMinor ?? 0,
        balanceMinor: d.balanceMinor ?? 0,
      };
    }),
    topCustomers: topCustAgg.map((c: { _id: string; revenue: number; count: number }) => ({
      name: c._id,
      revenueMinor: c.revenue,
      invoiceCount: c.count,
    })),
    expenseBreakdown: expByCatAgg.map((e: { _id: string; total: number }) => ({
      category: catNameMap.get(e._id) || e._id || "Other",
      totalMinor: e.total,
    })),
    aging,
  };
}
