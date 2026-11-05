import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { Employee } from "../employee/employee.model";
import { Department } from "../department/department.model";
import { Invoice } from "../invoice/invoice.model";
import { Expense } from "../expense/expense.model";
import { pnlExpenseFilter } from "../expense-category/expense-category.service";
import { CommissionRecord } from "../commission/commission-record.model";
import { PayrollRun } from "./payroll-run.model";
import { formatMinor } from "./money";
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

/**
 * Who a person page is about: their payroll record, or — a `login-` row — the login of somebody on invoices with no
 * payroll record of their own (2026-10-27). Should their login have been put on a payroll record since, that record
 * answers.
 */
async function resolvePerson(orgId: string, employeeId: string) {
  const org = oid(orgId);
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
  const uid = employee ? employee.userId : login!._id;
  return { employee, login, rowId, uid };
}

/** One person, with the documents behind each figure rather than just the sums. */
export async function personDetail(orgId: string, employeeId: string, query: { from: string; to: string }) {
  const org = oid(orgId);
  const from = new Date(query.from);
  const to = new Date(`${query.to}T23:59:59.999Z`);
  const { employee, login, rowId, uid } = await resolvePerson(orgId, employeeId);

  const summary = await peopleReport(orgId, { from: query.from, to: query.to }, { withLogins: !employee });
  const row = summary.rows.find((r) => r.employeeId === rowId);

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
          .filter((a) => (a.source === "commission" || a.source === "crm_commission" || a.source === "cs_commission") && String(a.lineId) === String(l._id))
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

/**
 * A person's ledger (the user, 2026-11-05: "a new tab, Ledger — every expense and payroll, invoices raised, commission
 * and other payments in a single table, as a full ledger … click one to see which invoice or expense").
 *
 * One row per document, newest first: each invoice they raised (what they brought in), each payroll month (what it
 * paid them, its commission inside it — "show on the payroll, no need separate"), each expense entered for them or
 * claimed by them (as the Expenses tab counts them), and each salary advance or one-time payment HRMS sent finance
 * for them. An advance or one-time payment names its employee only in its notes, "Name (E0212)", so it is found by
 * their employee code there. Searched, filtered and paged here, not in the browser.
 */
export const LEDGER_KINDS = ["invoice", "payroll", "expense", "advance", "one_time"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export interface LedgerFact { label: string; text?: string; minor?: number; currency?: string }
export interface LedgerRow {
  id: string;
  kind: LedgerKind;
  date: string;
  reference: string;
  title: string;
  subtitle: string;
  currency: string;
  /** Brought in: an invoice's total. */
  inMinor: number;
  /** Paid to them or spent on them. */
  outMinor: number;
  /** In the totals: a payroll month nothing of which is paid yet is shown, not counted. */
  counted: boolean;
  status: string;
  href: string | null;
  facts: LedgerFact[];
  sections: Array<{ title: string; items: LedgerFact[] }>;
}

export interface LedgerQuery {
  page: number;
  pageSize: number;
  kind?: LedgerKind;
  q?: string;
  from?: string;
  to?: string;
  sort?: "asc" | "desc";
}

/** The most of any one kind a ledger reads; past it the answer says so. */
const LEDGER_CAP = 2000;
const COMMISSION_SOURCES = new Set(["commission", "crm_commission", "cs_commission"]);
const escapeRegExp = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isoDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const methodText = (m?: string | null) => (m ? m.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "");
const monthEnd = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0, 12));
};
const monthText = (period: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${period}-01T00:00:00Z`));

export async function personLedger(orgId: string, employeeId: string, query: LedgerQuery) {
  const org = oid(orgId);
  const { employee, uid } = await resolvePerson(orgId, employeeId);
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : null;
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : null;
  const range = from || to ? { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } : null;
  const rows: LedgerRow[] = [];
  let capped = false;
  const cap = <T,>(list: T[]) => { if (list.length >= LEDGER_CAP) capped = true; return list; };

  // What they brought in: the invoices they raised.
  if (uid) {
    const invoices = cap(await Invoice.find({
      organizationId: org, salespersonId: uid, status: { $nin: ["void", "draft"] }, ...(range ? { issueDate: range } : {}),
    })
      .select("invoiceNumber customerName issueDate dueDate totalMinor amountPaidMinor balanceMinor status currency enrolment.course")
      .sort({ issueDate: -1 }).limit(LEDGER_CAP).lean<any[]>());
    for (const i of invoices) {
      const cur = String(i.currency ?? "AED");
      rows.push({
        id: `invoice:${i._id}`, kind: "invoice", date: new Date(i.issueDate).toISOString(), reference: String(i.invoiceNumber ?? ""),
        title: String(i.customerName ?? ""), subtitle: String(i.enrolment?.course ?? ""), currency: cur,
        inMinor: i.totalMinor ?? 0, outMinor: 0, counted: true, status: String(i.status ?? ""), href: `/invoices/${i._id}`,
        facts: [
          { label: "Customer", text: String(i.customerName ?? "") },
          ...(i.enrolment?.course ? [{ label: "Course", text: String(i.enrolment.course) }] : []),
          { label: "Issued", text: isoDay(i.issueDate) },
          ...(i.dueDate ? [{ label: "Due", text: isoDay(i.dueDate) }] : []),
          { label: "Total", minor: i.totalMinor ?? 0, currency: cur },
          { label: "Paid", minor: i.amountPaidMinor ?? 0, currency: cur },
          { label: "Balance", minor: i.balanceMinor ?? 0, currency: cur },
        ],
        sections: [],
      });
    }
  }

  // Payroll: one row a month, what it paid them; the commission and anything else accounts added inside it.
  if (employee) {
    const runs = cap(await PayrollRun.find({ organizationId: org, status: { $ne: "voided" }, "lines.employeeId": employee._id })
      .sort({ period: -1 }).limit(LEDGER_CAP).lean<any[]>());
    for (const run of runs) {
      for (const l of (run.lines ?? []).filter((x: any) => String(x.employeeId) === String(employee._id))) {
        const cur = String(l.currency || run.currency);
        const pays = (run.payments ?? []).flatMap((p: any) => {
          const a = (p.allocations ?? []).find((x: any) => String(x.lineId) === String(l._id));
          return a ? [{ p, amountMinor: Number(a.amountMinor ?? 0) }] : [];
        });
        const last = pays.filter((x: any) => !x.p.reversedAt).map((x: any) => new Date(x.p.paidOn)).sort((a: Date, b: Date) => b.getTime() - a.getTime())[0];
        // Paid: the day the last of it went. Not yet: the month's last day.
        const date = last ?? monthEnd(run.period);
        const mine = (run.adjustments ?? []).filter((a: any) => String(a.lineId) === String(l._id));
        const commission = mine.filter((a: any) => COMMISSION_SOURCES.has(a.source)).reduce((t: number, a: any) => t + (a.recoveredMinor ?? 0), 0);
        const paid = Number(l.amountPaidMinor ?? 0);
        rows.push({
          id: `payroll:${run._id}:${l._id}`, kind: "payroll", date: date.toISOString(), reference: String(run.runNumber ?? ""),
          title: `Salary — ${monthText(run.period)}`,
          subtitle: commission ? `of which commission ${formatMinor(commission, cur)}` : "",
          currency: cur, inMinor: 0, outMinor: paid, counted: paid > 0, status: String(l.status ?? ""), href: `/payroll/runs/${run._id}`,
          facts: [
            { label: "Month", text: monthText(run.period) },
            { label: "Run", text: String(run.runNumber ?? "") },
            { label: "Gross", minor: l.grossMinor ?? 0, currency: cur },
            { label: "Deductions", minor: l.deductionsMinor ?? 0, currency: cur },
            ...(l.adjustmentsMinor ? [{ label: "Added or taken off by accounts", minor: l.adjustmentsMinor, currency: cur }] : []),
            ...(commission ? [{ label: "Of which commission", minor: commission, currency: cur }] : []),
            { label: "Payable", minor: l.payableMinor ?? 0, currency: cur },
            { label: "Paid", minor: paid, currency: cur },
            ...((l.payableMinor ?? 0) - paid > 0 ? [{ label: "Still owed", minor: (l.payableMinor ?? 0) - paid, currency: cur }] : []),
            ...(l.holdReason ? [{ label: "Held", text: String(l.holdReason) }] : []),
          ],
          sections: [
            {
              title: "Added or taken off by accounts",
              items: mine.map((a: any) => ({
                label: `${a.kind === "deduction" ? "−" : "+"} ${a.label}${COMMISSION_SOURCES.has(a.source) ? " (commission)" : ""}`,
                minor: a.kind === "deduction" ? -(a.recoveredMinor ?? 0) : a.amountMinor ?? 0, currency: cur,
              })),
            },
            {
              title: "Payments",
              items: pays.map((x: any) => ({
                label: `${x.p.paymentId} · ${methodText(x.p.method)} · ${isoDay(x.p.paidOn)}${x.p.reversedAt ? " · reversed" : ""}`,
                minor: x.amountMinor, currency: cur,
              })),
            },
          ].filter((sec) => sec.items.length > 0),
        });
      }
    }
  }

  // Expenses entered for them, or their own claim for nobody — as the Expenses tab and the cost count them.
  const listed = new Set<string>();
  if (uid) {
    const pnl = await pnlExpenseFilter(orgId);
    const expenses = cap(await Expense.find({
      organizationId: org, status: { $in: ["approved", "submitted"] },
      $or: [{ salespersonId: uid }, { salespersonId: null, submittedById: uid }],
      // An advance or one-time payment is paid to its employee, below — not the accountant who approved it (its
      // submitter), whose own claim it would otherwise read as; a payroll payment's expense is the payroll rows'.
      "source.kind": { $nin: ["import", "bill", "hrms_advance", "hrms_one_time", "payroll"] },
      ...pnl,
      ...(range ? { expenseDate: range } : {}),
    })
      .select("expenseNumber description categoryName subcategoryName expenseDate totalMinor status currency salespersonId submittedByName paidOn paymentMethod reference")
      .sort({ expenseDate: -1 }).limit(LEDGER_CAP).lean<any[]>());
    for (const e of expenses) {
      listed.add(String(e._id));
      const cur = String(e.currency ?? "AED");
      rows.push({
        id: `expense:${e._id}`, kind: "expense", date: new Date(e.expenseDate).toISOString(), reference: String(e.expenseNumber || ""),
        title: String(e.description || e.categoryName || "Expense"), subtitle: [e.categoryName, e.subcategoryName].filter(Boolean).join(" · "),
        currency: cur, inMinor: 0, outMinor: e.totalMinor ?? 0, counted: true, status: String(e.status ?? ""), href: `/expenses/${e._id}`,
        facts: [
          { label: "Category", text: [e.categoryName, e.subcategoryName].filter(Boolean).join(" · ") || "—" },
          { label: "Description", text: String(e.description ?? "") },
          { label: "Date", text: isoDay(e.expenseDate) },
          { label: "Amount", minor: e.totalMinor ?? 0, currency: cur },
          { label: "For them / own", text: e.salespersonId ? `For them${e.submittedByName ? ` · entered by ${e.submittedByName}` : ""}` : "Own claim" },
          ...(e.paidOn ? [{ label: "Paid on", text: isoDay(e.paidOn) }] : []),
          ...(e.paymentMethod ? [{ label: "Paid by", text: methodText(e.paymentMethod) }] : []),
          ...(e.reference ? [{ label: "Reference", text: String(e.reference) }] : []),
        ],
        sections: [],
      });
    }
  }

  // Salary advances and one-time payments HRMS sent finance for them: their employee code is in the notes.
  const code = employee?.employeeCode ? String(employee.employeeCode) : "";
  if (code) {
    const paidOut = cap(await Expense.find({
      organizationId: org, "source.kind": { $in: ["hrms_advance", "hrms_one_time"] }, status: { $nin: ["rejected", "voided", "draft"] },
      notes: new RegExp(`\\(${escapeRegExp(code)}\\)`), ...(range ? { expenseDate: range } : {}),
    })
      .select("expenseNumber description expenseDate totalMinor status currency paidOn paymentMethod reference notes source.kind")
      .sort({ expenseDate: -1 }).limit(LEDGER_CAP).lean<any[]>());
    for (const e of paidOut) {
      if (listed.has(String(e._id))) continue;
      const cur = String(e.currency ?? "AED");
      const advance = e.source?.kind === "hrms_advance";
      rows.push({
        id: `${advance ? "advance" : "one_time"}:${e._id}`, kind: advance ? "advance" : "one_time", date: new Date(e.expenseDate).toISOString(),
        reference: String(e.expenseNumber || ""), title: advance ? "Salary advance" : "One-time payment",
        subtitle: advance ? "Recovered from their pay" : String(e.description ?? ""),
        currency: cur, inMinor: 0, outMinor: e.totalMinor ?? 0, counted: true, status: String(e.status ?? ""), href: `/expenses/${e._id}`,
        facts: [
          { label: "Date", text: isoDay(e.expenseDate) },
          { label: "Amount", minor: e.totalMinor ?? 0, currency: cur },
          ...(e.paidOn ? [{ label: "Paid on", text: isoDay(e.paidOn) }] : []),
          ...(e.paymentMethod ? [{ label: "Paid by", text: methodText(e.paymentMethod) }] : []),
          ...(e.reference ? [{ label: "Reference", text: String(e.reference) }] : []),
        ],
        sections: e.notes ? [{ title: "From HRMS", items: String(e.notes).split("\n").filter(Boolean).map((t) => ({ label: t })) }] : [],
      });
    }
  }

  // Dated within the range (a payroll month's date is worked out above, so it is checked here), and the search.
  const needle = (query.q ?? "").trim().toLowerCase();
  const inRange = rows.filter((r) => {
    const t = new Date(r.date).getTime();
    return (!from || t >= from.getTime()) && (!to || t <= to.getTime());
  });
  const found = needle
    ? inRange.filter((r) => [r.reference, r.title, r.subtitle, r.status].some((x) => x.toLowerCase().includes(needle)))
    : inRange;
  const counts = Object.fromEntries(LEDGER_KINDS.map((k) => [k, found.filter((r) => r.kind === k).length])) as Record<LedgerKind, number>;
  const list = query.kind ? found.filter((r) => r.kind === query.kind) : found;

  const dir = query.sort === "asc" ? 1 : -1;
  list.sort((a, b) => dir * (new Date(a.date).getTime() - new Date(b.date).getTime()) || dir * a.id.localeCompare(b.id));

  // Each currency apart: never added across them.
  const byCurrency = new Map<string, { currency: string; inMinor: number; outMinor: number }>();
  for (const r of list) {
    if (!r.counted) continue;
    const t = byCurrency.get(r.currency) ?? { currency: r.currency, inMinor: 0, outMinor: 0 };
    t.inMinor += r.inMinor;
    t.outMinor += r.outMinor;
    byCurrency.set(r.currency, t);
  }

  const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize) || 25));
  const pageCount = Math.max(1, Math.ceil(list.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(query.page) || 1));
  return {
    rows: list.slice((page - 1) * pageSize, page * pageSize),
    meta: { page, pageSize, total: list.length, pageCount },
    totals: [...byCurrency.values()].sort((a, b) => b.inMinor + b.outMinor - (a.inMinor + a.outMinor)),
    counts,
    capped,
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
