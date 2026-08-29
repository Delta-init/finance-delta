import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { Employee } from "../employee/employee.model";
import { Department } from "../department/department.model";
import { Invoice } from "../invoice/invoice.model";
import { Expense } from "../expense/expense.model";
import { CommissionRecord } from "../commission/commission-record.model";
import { PayrollRun } from "./payroll-run.model";

const oid = (id: string) => new Types.ObjectId(id);

/**
 * What each person earned the business, and what they cost it.
 *
 * Built from the roster rather than from activity. The existing salesperson
 * report groups invoices, so somebody who raised none simply has no row — which
 * is the right answer for "who sold the most" and the wrong one for "who works
 * here and what did they cost". This starts from every mapped employee and
 * attaches figures to them, so a person with no sales appears with zeroes
 * instead of vanishing.
 *
 * Cost is payroll paid plus expenses claimed. Commission is deliberately *not*
 * added on top: it is pulled onto a payroll run as an addition, so the amount
 * paid already contains it. Adding the two would double-count every commission
 * payment, which on a real month is a materially wrong number. It is reported
 * separately as a breakdown of the payroll figure, never as an addend.
 */

export interface PersonRow {
  employeeId: string;
  employeeCode: string;
  name: string;
  designation: string;
  departmentId: string | null;
  departmentName: string;
  userId: string | null;
  status: "active" | "inactive";

  /** What they brought in. */
  invoiceCount: number;
  invoicedMinor: number;
  /** Of what they invoiced, how much has been collected and how much has not. */
  invoicePaidMinor: number;
  invoiceOutstandingMinor: number;

  /** What they cost. */
  payrollPaidMinor: number;
  expensesMinor: number;
  totalCostMinor: number;

  /** Inside payrollPaidMinor, not additional to it. */
  commissionInPayrollMinor: number;
  /** Earned but not yet paid through a run. */
  commissionOutstandingMinor: number;
}

/** A month is in range when it overlaps the requested dates at all. */
function periodRange(from: string, to: string): { $gte: string; $lte: string } {
  return { $gte: from.slice(0, 7), $lte: to.slice(0, 7) };
}

interface Query {
  from: string;
  to: string;
  departmentId?: string;
  search?: string;
}

export async function peopleReport(orgId: string, query: Query) {
  const org = oid(orgId);
  const from = new Date(query.from);
  const to = new Date(`${query.to}T23:59:59.999Z`);

  const filter: Record<string, unknown> = { organizationId: org };
  if (query.departmentId) filter.departmentId = oid(query.departmentId);
  if (query.search) {
    const rx = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { employeeCode: rx }, { email: rx }];
  }

  const employees = await Employee.find(filter).populate("departmentId", "name").sort({ name: 1 }).lean();
  if (!employees.length) {
    return { rows: [], totals: emptyTotals(), currency: "AED" };
  }

  const userIds = employees.filter((e) => e.userId).map((e) => e.userId as Types.ObjectId);
  const employeeIds = employees.map((e) => e._id);

  // ── What they brought in ────────────────────────────────────────────────
  const invoiceAgg = userIds.length
    ? await Invoice.aggregate([
        {
          $match: {
            organizationId: org,
            salespersonId: { $in: userIds },
            issueDate: { $gte: from, $lte: to },
            status: { $nin: ["void", "draft"] },
          },
        },
        {
          $group: {
            _id: "$salespersonId",
            count: { $sum: 1 },
            total: { $sum: "$totalMinor" },
            paid: { $sum: "$amountPaidMinor" },
            outstanding: { $sum: "$balanceMinor" },
          },
        },
      ])
    : [];
  const invoices = new Map(invoiceAgg.map((r) => [String(r._id), r]));

  // ── Payroll paid, and how much of it was commission ─────────────────────
  // Read from the runs rather than aggregated in Mongo: the commission share
  // lives on the run's adjustments and has to be matched back to its line,
  // which is a join the aggregation pipeline cannot express cheaply.
  const runs = await PayrollRun.find({
    organizationId: org,
    period: periodRange(query.from, query.to),
    status: { $ne: "voided" },
  }).lean();

  const paid = new Map<string, { payroll: number; commission: number }>();
  for (const run of runs) {
    for (const line of run.lines) {
      if (!line.employeeId) continue;
      const key = String(line.employeeId);
      const entry = paid.get(key) ?? { payroll: 0, commission: 0 };
      entry.payroll += line.amountPaidMinor ?? 0;
      for (const adj of run.adjustments) {
        if (adj.source !== "commission") continue;
        if (String(adj.lineId) !== String(line._id)) continue;
        entry.commission += adj.recoveredMinor ?? 0;
      }
      paid.set(key, entry);
    }
  }

  // ── Expenses they claimed ───────────────────────────────────────────────
  // Same statuses the profit and loss counts, so a person's cost here and the
  // expense total in the accounts cannot disagree.
  const expenseAgg = userIds.length
    ? await Expense.aggregate([
        {
          $match: {
            organizationId: org,
            submittedById: { $in: userIds },
            expenseDate: { $gte: from, $lte: to },
            status: { $in: ["approved", "submitted"] },
          },
        },
        { $group: { _id: "$submittedById", total: { $sum: "$totalMinor" } } },
      ])
    : [];
  const expenses = new Map(expenseAgg.map((r) => [String(r._id), r.total as number]));

  // ── Commission earned but not yet paid through a run ────────────────────
  const owedAgg = userIds.length
    ? await CommissionRecord.aggregate([
        { $match: { organizationId: org, salespersonId: { $in: userIds }, status: "earned" } },
        { $group: { _id: "$salespersonId", total: { $sum: "$commissionMinor" } } },
      ])
    : [];
  const owed = new Map(owedAgg.map((r) => [String(r._id), r.total as number]));

  const rows: PersonRow[] = employees.map((e) => {
    const uid = e.userId ? String(e.userId) : "";
    const inv = invoices.get(uid);
    const pay = paid.get(String(e._id)) ?? { payroll: 0, commission: 0 };
    const exp = expenses.get(uid) ?? 0;

    return {
      employeeId: String(e._id),
      employeeCode: e.employeeCode,
      name: e.name,
      designation: e.designation ?? "",
      departmentId: e.departmentId ? String((e.departmentId as unknown as { _id: Types.ObjectId })._id) : null,
      departmentName: e.departmentId ? (e.departmentId as unknown as { name: string }).name : "",
      userId: e.userId ? String(e.userId) : null,
      status: e.status as "active" | "inactive",

      invoiceCount: inv?.count ?? 0,
      invoicedMinor: inv?.total ?? 0,
      invoicePaidMinor: inv?.paid ?? 0,
      invoiceOutstandingMinor: inv?.outstanding ?? 0,

      payrollPaidMinor: pay.payroll,
      expensesMinor: exp,
      // The agreed definition. Commission is inside payrollPaid already.
      totalCostMinor: pay.payroll + exp,

      commissionInPayrollMinor: pay.commission,
      commissionOutstandingMinor: owed.get(uid) ?? 0,
    };
  });

  void employeeIds;
  return {
    rows,
    totals: rows.reduce(
      (a, r) => ({
        people: a.people + 1,
        invoiceCount: a.invoiceCount + r.invoiceCount,
        invoicedMinor: a.invoicedMinor + r.invoicedMinor,
        invoicePaidMinor: a.invoicePaidMinor + r.invoicePaidMinor,
        invoiceOutstandingMinor: a.invoiceOutstandingMinor + r.invoiceOutstandingMinor,
        payrollPaidMinor: a.payrollPaidMinor + r.payrollPaidMinor,
        expensesMinor: a.expensesMinor + r.expensesMinor,
        totalCostMinor: a.totalCostMinor + r.totalCostMinor,
        commissionInPayrollMinor: a.commissionInPayrollMinor + r.commissionInPayrollMinor,
        commissionOutstandingMinor: a.commissionOutstandingMinor + r.commissionOutstandingMinor,
      }),
      emptyTotals(),
    ),
    currency: runs[0]?.currency ?? "AED",
  };
}

function emptyTotals() {
  return {
    people: 0, invoiceCount: 0, invoicedMinor: 0,
    invoicePaidMinor: 0, invoiceOutstandingMinor: 0,
    payrollPaidMinor: 0, expensesMinor: 0, totalCostMinor: 0,
    commissionInPayrollMinor: 0, commissionOutstandingMinor: 0,
  };
}

/** One person, with the documents behind each figure rather than just the sums. */
export async function personDetail(orgId: string, employeeId: string, query: { from: string; to: string }) {
  const org = oid(orgId);
  const from = new Date(query.from);
  const to = new Date(`${query.to}T23:59:59.999Z`);

  const employee = await Employee.findOne({ _id: oid(employeeId), organizationId: org })
    .populate("departmentId", "name")
    .lean();
  if (!employee) throw new AppError("NOT_FOUND", "Person not found");

  const summary = await peopleReport(orgId, { from: query.from, to: query.to });
  const row = summary.rows.find((r) => r.employeeId === employeeId);

  const uid = employee.userId;

  const [invoices, expenses, commissions] = await Promise.all([
    uid
      ? Invoice.find({ organizationId: org, salespersonId: uid, issueDate: { $gte: from, $lte: to }, status: { $nin: ["void", "draft"] } })
          .select("invoiceNumber customerName issueDate totalMinor status currency")
          .sort({ issueDate: -1 })
          .limit(200)
          .lean()
      : [],
    uid
      ? Expense.find({ organizationId: org, submittedById: uid, expenseDate: { $gte: from, $lte: to }, status: { $in: ["approved", "submitted"] } })
          .select("expenseNumber description categoryName expenseDate totalMinor status currency")
          .sort({ expenseDate: -1 })
          .limit(200)
          .lean()
      : [],
    uid
      ? CommissionRecord.find({ organizationId: org, salespersonId: uid })
          .select("invoiceNumber commissionMinor status calculatedAt paidAt")
          .sort({ calculatedAt: -1 })
          .limit(200)
          .lean()
      : [],
  ]);

  // Their payroll lines, month by month, so the salary figure can be opened up.
  const runs = await PayrollRun.find({
    organizationId: org,
    period: periodRange(query.from, query.to),
    status: { $ne: "voided" },
    "lines.employeeId": employee._id,
  }).lean();

  const payslips = runs.flatMap((run) =>
    run.lines
      .filter((l) => String(l.employeeId) === String(employee._id))
      .map((l) => ({
        runId: String(run._id),
        runNumber: run.runNumber,
        period: run.period,
        status: run.status,
        currency: run.currency,
        grossMinor: l.grossMinor,
        deductionsMinor: l.deductionsMinor,
        payableMinor: l.payableMinor,
        amountPaidMinor: l.amountPaidMinor,
        commissionMinor: run.adjustments
          .filter((a) => a.source === "commission" && String(a.lineId) === String(l._id))
          .reduce((s, a) => s + (a.recoveredMinor ?? 0), 0),
      })),
  );

  return {
    person: {
      employeeId: String(employee._id),
      employeeCode: employee.employeeCode,
      name: employee.name,
      email: employee.email ?? "",
      designation: employee.designation ?? "",
      departmentId: employee.departmentId ? String((employee.departmentId as unknown as { _id: Types.ObjectId })._id) : null,
      departmentName: employee.departmentId ? (employee.departmentId as unknown as { name: string }).name : "",
      status: employee.status,
      hasLogin: Boolean(uid),
    },
    summary: row ?? null,
    payslips,
    invoices: invoices.map((i) => ({
      id: String(i._id), invoiceNumber: i.invoiceNumber, customerName: i.customerName,
      issueDate: (i.issueDate as Date).toISOString(), totalMinor: i.totalMinor ?? 0,
      status: i.status, currency: i.currency ?? "AED",
    })),
    expenses: expenses.map((e) => ({
      id: String(e._id), expenseNumber: e.expenseNumber, description: e.description,
      categoryName: e.categoryName ?? "", expenseDate: (e.expenseDate as Date).toISOString(),
      totalMinor: e.totalMinor ?? 0, status: e.status, currency: e.currency ?? "AED",
    })),
    commissions: commissions.map((c) => ({
      id: String(c._id), invoiceNumber: c.invoiceNumber, commissionMinor: c.commissionMinor,
      status: c.status,
      calculatedAt: c.calculatedAt ? (c.calculatedAt as Date).toISOString() : null,
      paidAt: c.paidAt ? (c.paidAt as Date).toISOString() : null,
    })),
  };
}

/** Departments, each with its headcount and what it earned and cost. */
export async function departmentReport(orgId: string, query: { from: string; to: string }) {
  const { rows, currency } = await peopleReport(orgId, query);
  const departments = await Department.find({ organizationId: oid(orgId) }).select("name").sort({ name: 1 }).lean();

  const byDept = new Map<string, PersonRow[]>();
  for (const r of rows) {
    const key = r.departmentId ?? "";
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key)!.push(r);
  }

  const out = departments.map((d) => summarise(String(d._id), d.name, byDept.get(String(d._id)) ?? []));
  // People with no department are still on the payroll and still cost money;
  // dropping them would make the totals here disagree with the people report.
  const orphans = byDept.get("") ?? [];
  if (orphans.length) out.push(summarise(null, "No department", orphans));

  return { departments: out, currency };
}

function summarise(id: string | null, name: string, people: PersonRow[]) {
  return {
    departmentId: id,
    name,
    headcount: people.length,
    invoicedMinor: people.reduce((s, p) => s + p.invoicedMinor, 0),
    invoicePaidMinor: people.reduce((s, p) => s + p.invoicePaidMinor, 0),
    invoiceOutstandingMinor: people.reduce((s, p) => s + p.invoiceOutstandingMinor, 0),
    payrollPaidMinor: people.reduce((s, p) => s + p.payrollPaidMinor, 0),
    expensesMinor: people.reduce((s, p) => s + p.expensesMinor, 0),
    totalCostMinor: people.reduce((s, p) => s + p.totalCostMinor, 0),
    commissionInPayrollMinor: people.reduce((s, p) => s + p.commissionInPayrollMinor, 0),
  };
}
