import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { Employee } from "../employee/employee.model";
import { Department } from "../department/department.model";
import { Invoice } from "../invoice/invoice.model";
import { Expense } from "../expense/expense.model";
import { pnlExpenseFilter } from "../expense-category/expense-category.service";
import { CommissionRecord } from "../commission/commission-record.model";
import { PayrollRun } from "./payroll-run.model";
import { User } from "../user/user.model";

const oid = (id: string) => new Types.ObjectId(id);

/**
 * A row's id for somebody named on invoices whose login is on nobody's payroll record (2026-10-27: Super Admin,
 * Fayis, imported old-books names — AED 229k of October's invoicing had no row, and Delta Banglore has no payroll at
 * all). Payroll people keep their employee id.
 */
const LOGIN_PREFIX = "login-";
const loginRowId = (userId: string) => `${LOGIN_PREFIX}${userId}`;

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
  /** The payroll employee's id — or `login-<userId>` for someone on invoices who is not on the payroll. */
  employeeId: string;
  /** False for those `login-` rows: no payroll record, so no payroll cost. */
  onPayroll: boolean;
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

interface Options {
  /** Add a row for each login named on invoices (or owed commission) in the range that is on nobody's payroll record. */
  withLogins?: boolean;
}

export async function peopleReport(orgId: string, query: Query, opts: Options = {}) {
  const org = oid(orgId);
  const from = new Date(query.from);
  const to = new Date(`${query.to}T23:59:59.999Z`);
  const rx = query.search ? new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;

  const filter: Record<string, unknown> = { organizationId: org };
  if (query.departmentId) filter.departmentId = oid(query.departmentId);
  if (rx) filter.$or = [{ name: rx }, { employeeCode: rx }, { email: rx }];

  const employees = await Employee.find(filter).populate("departmentId", "name").sort({ name: 1 }).lean();

  // Logins on invoices that no payroll record (whatever the search) carries — a department filter
  // asks about payroll people, so it leaves them out.
  let logins: { _id: Types.ObjectId; name?: string; email?: string; status?: string }[] = [];
  if (opts.withLogins && !query.departmentId) {
    const [onPayroll, invoiced, owing] = await Promise.all([
      Employee.distinct("userId", { organizationId: org, userId: { $type: "objectId" } }),
      Invoice.distinct("salespersonId", { organizationId: org, issueDate: { $gte: from, $lte: to }, status: { $nin: ["void", "draft"] } }),
      CommissionRecord.distinct("salespersonId", { organizationId: org, status: "earned" }),
    ]);
    const linked = new Set(onPayroll.map(String));
    const ids = [...new Set([...invoiced, ...owing].filter(Boolean).map(String))].filter((id) => !linked.has(id));
    if (ids.length) {
      const userFilter: Record<string, unknown> = { _id: { $in: ids.map(oid) } };
      if (rx) userFilter.$or = [{ name: rx }, { email: rx }];
      logins = await User.find(userFilter).select("name email status").sort({ name: 1 }).lean();
    }
  }

  if (!employees.length && !logins.length) {
    return { rows: [], totals: emptyTotals(), currency: "AED" };
  }

  const userIds = [
    ...employees.filter((e) => e.userId).map((e) => e.userId as Types.ObjectId),
    ...logins.map((u) => u._id),
  ];
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

  // ── Their expenses ──────────────────────────────────────────────────────
  // Same statuses the profit and loss counts, so a person's cost here and the
  // expense total in the accounts cannot disagree. An expense entered for a
  // salesperson (2026-10-21) is theirs, whoever typed it; one for nobody is the
  // claimant's — each counted once, for one person.
  const expenseAgg = userIds.length
    ? await Expense.aggregate([
        {
          $match: {
            organizationId: org,
            expenseDate: { $gte: from, $lte: to },
            status: { $in: ["approved", "submitted"] },
            $or: [{ salespersonId: { $in: userIds } }, { salespersonId: null, submittedById: { $in: userIds } }],
            // The old books' imported rows are nobody's claim, whoever ran the import.
            "source.kind": { $nin: ["import", "bill"] },
            ...(await pnlExpenseFilter(orgId)),
          },
        },
        { $group: { _id: { $ifNull: ["$salespersonId", "$submittedById"] }, total: { $sum: "$totalMinor" } } },
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
      onPayroll: true,
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

  // Not on the payroll: what they invoiced and claimed; no payroll cost.
  for (const u of logins) {
    const uid = String(u._id);
    const inv = invoices.get(uid);
    const exp = expenses.get(uid) ?? 0;
    rows.push({
      employeeId: loginRowId(uid),
      onPayroll: false,
      employeeCode: "",
      name: String(u.name || u.email || "Unnamed login"),
      designation: "",
      departmentId: null,
      departmentName: "",
      userId: uid,
      status: u.status === "active" ? "active" : "inactive",
      invoiceCount: inv?.count ?? 0,
      invoicedMinor: inv?.total ?? 0,
      invoicePaidMinor: inv?.paid ?? 0,
      invoiceOutstandingMinor: inv?.outstanding ?? 0,
      payrollPaidMinor: 0,
      expensesMinor: exp,
      totalCostMinor: exp,
      commissionInPayrollMinor: 0,
      commissionOutstandingMinor: owed.get(uid) ?? 0,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

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

  // A `login-` row: someone on invoices with no payroll record of their own (2026-10-27). Should their login have been
  // put on a payroll record since, that record answers.
  let login: { _id: Types.ObjectId; name?: string; email?: string; status?: string; memberships?: { organizationId: Types.ObjectId }[] } | null = null;
  let employee;
  if (employeeId.startsWith(LOGIN_PREFIX)) {
    const userId = employeeId.slice(LOGIN_PREFIX.length);
    if (!Types.ObjectId.isValid(userId)) throw new AppError("NOT_FOUND", "Person not found");
    employee = await Employee.findOne({ userId: oid(userId), organizationId: org }).populate("departmentId", "name").lean();
    if (!employee) {
      login = await User.findById(userId).select("name email status memberships.organizationId").lean();
      // Someone of this organization, or named on its invoices — never just any login.
      const ofOrg = login && (login.memberships?.some((m) => String(m.organizationId) === orgId)
        || await Invoice.exists({ organizationId: org, salespersonId: login._id }));
      if (!login || !ofOrg) throw new AppError("NOT_FOUND", "Person not found");
    }
  } else {
    if (!Types.ObjectId.isValid(employeeId)) throw new AppError("NOT_FOUND", "Person not found");
    employee = await Employee.findOne({ _id: oid(employeeId), organizationId: org })
      .populate("departmentId", "name")
      .lean();
    if (!employee) throw new AppError("NOT_FOUND", "Person not found");
  }
  const rowId = employee ? String(employee._id) : loginRowId(String(login!._id));

  const summary = await peopleReport(orgId, { from: query.from, to: query.to }, { withLogins: !employee });
  const row = summary.rows.find((r) => r.employeeId === rowId);

  const uid = employee ? employee.userId : login!._id;

  const pnl = await pnlExpenseFilter(orgId);
  const [invoices, expenses, commissions] = await Promise.all([
    uid
      ? Invoice.find({ organizationId: org, salespersonId: uid, issueDate: { $gte: from, $lte: to }, status: { $nin: ["void", "draft"] } })
          .select("invoiceNumber customerName issueDate totalMinor status currency")
          .sort({ issueDate: -1 })
          .limit(200)
          .lean()
      : [],
    uid
      ? Expense.find({
          organizationId: org, expenseDate: { $gte: from, $lte: to }, status: { $in: ["approved", "submitted"] },
          // Entered for them (2026-10-21), or their own claim for nobody — as the cost above counts them.
          $or: [{ salespersonId: uid }, { salespersonId: null, submittedById: uid }],
          "source.kind": { $nin: ["import", "bill"] },
          ...pnl,
        })
          .select("expenseNumber description categoryName expenseDate totalMinor status currency salespersonId submittedByName")
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
  const runs = employee
    ? await PayrollRun.find({
        organizationId: org,
        period: periodRange(query.from, query.to),
        status: { $ne: "voided" },
        "lines.employeeId": employee._id,
      }).lean()
    : [];

  const payslips = runs.flatMap((run) =>
    run.lines
      .filter((l) => String(l.employeeId) === String(employee!._id))
      .map((l) => ({
        runId: String(run._id),
        runNumber: run.runNumber,
        period: run.period,
        status: run.status,
        // Their own: somebody paid in rupees has a rupee payslip on a dirham run.
        currency: l.currency || run.currency,
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
    person: employee
      ? {
          employeeId: String(employee._id),
          onPayroll: true,
          employeeCode: employee.employeeCode,
          name: employee.name,
          email: employee.email ?? "",
          designation: employee.designation ?? "",
          departmentId: employee.departmentId ? String((employee.departmentId as unknown as { _id: Types.ObjectId })._id) : null,
          departmentName: employee.departmentId ? (employee.departmentId as unknown as { name: string }).name : "",
          status: employee.status,
          hasLogin: Boolean(uid),
        }
      : {
          employeeId: rowId,
          onPayroll: false,
          employeeCode: "",
          name: String(login!.name || login!.email || "Unnamed login"),
          email: login!.email ?? "",
          designation: "",
          departmentId: null,
          departmentName: "",
          status: login!.status === "active" ? "active" : "inactive",
          hasLogin: true,
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
      /** "for": entered for them (by whoever); "own": their own claim. */
      how: e.salespersonId ? ("for" as const) : ("own" as const),
      enteredBy: e.submittedByName ?? "",
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
