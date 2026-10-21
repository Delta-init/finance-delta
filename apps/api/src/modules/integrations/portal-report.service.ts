import { Types } from "mongoose";
import type { ApprovalRow } from "@delta/shared";
import { approvalList } from "../approvals/approvals.service";
import { getBudgetSummary } from "../budget/budget.service";
import { Organization } from "../organization/organization.model";
import { Department } from "../department/department.model";
import { Invoice } from "../invoice/invoice.model";
import { Expense } from "../expense/expense.model";
import { LateEntryModel } from "../late-entry/late-entry.model";

/**
 * GET /api/v1/service/finance-report?org&from&to — the Root portal's Reports →
 * Finance tab (the user, 2026-10-17): one organization over a period, in its
 * own currency (never added to another's), each section per person or group
 * and by month, with its rows —
 *
 *   expenses   expenses dated in the period, approved or paid (drafts,
 *              rejected and voided left out): by who submitted, department,
 *              category, payment method; paid vs still unpaid
 *   approvals  what was decided in the period — every kind the Approvals page
 *              decides, and late entries: by who decided and by kind, approved
 *              or rejected / sent back, the time each took and how many took
 *              over 30 minutes
 *   invoices   invoices issued in the period (by issue date): total, still
 *              outstanding, overdue, void — by salesperson and by CRM; and the
 *              payments received in the period on any invoice ("collected")
 *   budget     each department's month: allocated, top-ups, drawdowns,
 *              approved expenses, available, requests pending — the Budget
 *              page's own figures (getBudgetSummary)
 *   commission not yet — said so
 *
 * Amounts in major units. Read-only.
 */

const ROWS = 2000;
const DELAY_MINUTES = 30;
const UAE_MS = 4 * 3_600_000;
const major = (minor: unknown) => Math.round(Number(minor) || 0) / 100;
const cents = (n: number) => Math.round(n * 100) / 100;
const monthOf = (d: Date | string) => new Date(new Date(d).getTime() + UAE_MS).toISOString().slice(0, 7);
const CRM_OF_SOURCE: Record<string, string> = { crm: "Sales CRM", "draw-crm": "Draw", "banglore-crm": "Banglore", "remote-crm": "Remote", old_books: "Old books" };
const CRM_NAME: Record<string, string> = { delta: "Sales CRM", draw: "Draw", remote: "Remote", banglore: "Banglore" };

type Num = Record<string, number>;
/** Sums by a person (or anything named), by a group, and by month. */
function grouper(blank: () => Num) {
  const people = new Map<string, { id: string; name: string } & Num>(), groups = new Map<string, { team: string } & Num>(), months = new Map<string, { month: string } & Num>();
  const total = blank();
  const sum = (into: Num, add: Num) => { for (const [k, v] of Object.entries(add)) into[k] = cents((into[k] ?? 0) + v); };
  return {
    add(person: string, group: string, at: Date | string | null, add: Num) {
      const key = person || "—";
      const p = people.get(key) ?? ({ id: key, name: key, ...blank() } as { id: string; name: string } & Num); sum(p, add); people.set(key, p);
      const gk = group || "—";
      const g = groups.get(gk) ?? ({ team: gk, ...blank() } as { team: string } & Num); sum(g, add); groups.set(gk, g);
      if (at) { const m = monthOf(at); const r = months.get(m) ?? ({ month: m, ...blank() } as { month: string } & Num); sum(r, add); months.set(m, r); }
      sum(total, add);
    },
    out(sortKey: string) {
      const by = (a: Num, b: Num) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0);
      return { total, people: [...people.values()].sort(by), teams: [...groups.values()].sort(by), months: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)) };
    },
  };
}
const latest = <T extends { at: string }>(rows: T[]) => rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, ROWS);
type Tally = { count: number; amount: number };
const tally = (m: Map<string, Tally>, key: string, amount: number) => { const t = m.get(key) ?? { count: 0, amount: 0 }; t.count++; t.amount = cents(t.amount + amount); m.set(key, t); };
const bars = (m: Map<string, Tally>) => [...m].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.amount - a.amount);

export async function financeReportForPortal(q: { org?: string; from?: string; to?: string }) {
  const orgs = (await Organization.find().select("name baseCurrency").sort({ createdAt: 1 }).lean()) as unknown as { _id: Types.ObjectId; name: string; baseCurrency?: string }[];
  if (!orgs.length) return "No organization here";
  const org = q.org ? orgs.find((o) => String(o._id) === q.org) : orgs[0];
  if (!org) return "No such organization";
  const from = q.from ? new Date(q.from) : null, to = q.to ? new Date(q.to) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) return "from / to must be dates";
  if (from && to && from > to) return "from is after to";
  const range = from || to ? { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } : null;
  const inRange = (d: unknown) => { if (!d) return false; const t = new Date(d as Date).getTime(); return Number.isFinite(t) && (!from || t >= from.getTime()) && (!to || t <= to.getTime()); };
  const orgId = org._id;
  const currency = org.baseCurrency || "AED";

  const [departments, expenses, invoices, paidInvoices] = await Promise.all([
    Department.find({ organizationId: orgId }).select("name").lean(),
    Expense.find({ organizationId: orgId, status: "approved", ...(range ? { expenseDate: range } : {}) })
      .select("expenseNumber category categoryName subcategoryName description expenseDate totalMinor currency submittedByName departmentId paymentMethod paidOn approvedByName approvedAt source.kind").lean(),
    Invoice.find({ organizationId: orgId, ...(range ? { issueDate: range } : {}) })
      .select("invoiceNumber customerName salespersonName issueDate dueDate status totalMinor amountPaidMinor balanceMinor currency enrolment.crm enrolment.course external.source").lean(),
    Invoice.find({ organizationId: orgId, ...(range ? { "payments.paidOn": range } : { "payments.0": { $exists: true } }) })
      .select("invoiceNumber customerName salespersonName enrolment.crm external.source payments.amountMinor payments.paidOn payments.method").lean(),
  ]);
  const deptName = new Map((departments as any[]).map((d) => [String(d._id), String(d.name)]));
  const crmOf = (inv: any) => CRM_NAME[String(inv.enrolment?.crm ?? "")] || CRM_OF_SOURCE[String(inv.external?.source ?? "")] || (inv.external?.source ? String(inv.external.source) : "Typed in finance");

  /* ── Expenses ── */
  const eg = grouper(() => ({ expenses: 0, amount: 0, paid: 0, paid_amount: 0, unpaid: 0, unpaid_amount: 0 }));
  const byCategory = new Map<string, Tally>(), byMethod = new Map<string, Tally>();
  const expenseRows: any[] = [];
  for (const e of expenses as any[]) {
    const amount = major(e.totalMinor), paid = !!e.paidOn;
    const dept = deptName.get(String(e.departmentId ?? "")) || "No department";
    eg.add(String(e.submittedByName ?? ""), dept, e.expenseDate, { expenses: 1, amount, paid: paid ? 1 : 0, paid_amount: paid ? amount : 0, unpaid: paid ? 0 : 1, unpaid_amount: paid ? 0 : amount });
    const cat = String(e.categoryName || e.category || "Uncategorised") + (e.subcategoryName ? ` › ${e.subcategoryName}` : "");
    tally(byCategory, cat, amount);
    const meth = String(e.paymentMethod || "Not paid yet");
    tally(byMethod, meth, amount);
    expenseRows.push({ at: new Date(e.expenseDate).toISOString(), id: String(e._id), number: e.expenseNumber, title: String(e.description ?? ""), category: cat, department: dept,
      owner_id: String(e.submittedByName ?? ""), owner: String(e.submittedByName ?? ""), team: dept, amount, paid, paid_on: e.paidOn ? new Date(e.paidOn).toISOString() : "",
      method: String(e.paymentMethod ?? ""), from_hrms: String(e.source?.kind ?? "").startsWith("hrms_"), imported: e.source?.kind === "import", href: `/expenses/${e._id}` });
  }

  /* ── Approvals decided ── */
  const ag = grouper(() => ({ decided: 0, approved: 0, rejected: 0, minutes: 0, timed: 0, over_30: 0, avg_minutes: 0 }));
  const approvalRows: any[] = [];
  const auth = { userId: new Types.ObjectId().toString(), organizationId: String(orgId), role: "", permissions: [], isSuperAdmin: true };
  const decided: ApprovalRow[] = [];
  for (const status of ["approved", "rejected"] as const) {
    for (let page = 1; page <= 10; page++) {
      const r = await approvalList(auth, { status, page, pageSize: 100, ...(from ? { from: from.toISOString() } : {}), ...(to ? { to: to.toISOString() } : {}) } as any);
      decided.push(...r.rows);
      if (page >= r.meta.pageCount) break;
    }
  }
  const lateDecided = (await LateEntryModel.find({ organizationId: orgId, state: { $in: ["approved", "rejected"] }, ...(range ? { decidedAt: range } : {}) })
    .select("number title amountMinor currency enteredByName decidedByName decidedAt createdAt state").lean()) as any[];
  const addDecision = (d: { id: string; kind: string; title: string; by: string; raisedBy: string; outcome: string; submittedAt?: string; decidedAt?: string; amount?: number; href: string }) => {
    const mins = d.submittedAt && d.decidedAt ? Math.max(0, Math.round((Date.parse(d.decidedAt) - Date.parse(d.submittedAt)) / 60_000)) : NaN;
    const ok = d.outcome === "approved";
    ag.add(d.by || "Not recorded", d.kind, d.decidedAt ?? null, { decided: 1, approved: ok ? 1 : 0, rejected: ok ? 0 : 1, ...(Number.isFinite(mins) ? { minutes: mins, timed: 1, over_30: mins > DELAY_MINUTES ? 1 : 0 } : {}) });
    approvalRows.push({ at: d.decidedAt ?? "", id: d.id, kind: d.kind, title: d.title, outcome: d.outcome, owner_id: d.by || "Not recorded", owner: d.by || "Not recorded", team: d.kind,
      raised_by: d.raisedBy, submitted_at: d.submittedAt ?? "", minutes: Number.isFinite(mins) ? mins : null, amount: d.amount ?? null, href: d.href });
  };
  const KIND: Record<string, string> = { invoice: "Enrolment invoices", fund_request: "Fund requests", tetra_deposit: "Tetra Commission deposits", balance_payment: "Balance payments",
    expense: "Expense claims", bill: "Bills", payroll: "Payroll runs", procurement: "Purchase requests", salary_advance: "Salary advances", hiring: "Hiring requests" };
  for (const r of decided) {
    addDecision({ id: r.id, kind: KIND[r.type] ?? r.type, title: [r.title, r.subtitle].filter(Boolean).join(" · "), by: r.decidedBy ?? "", raisedBy: r.raisedBy ?? "",
      outcome: r.status === "approved" ? "approved" : r.status === "returned" ? "sent back" : "rejected", submittedAt: r.submittedAt, decidedAt: r.decidedAt ?? r.at,
      amount: r.amountMinor !== undefined ? major(r.amountMinor) : undefined, href: r.href });
  }
  for (const l of lateDecided) {
    addDecision({ id: String(l._id), kind: "Late entries", title: [l.number, l.title].filter(Boolean).join(" · "), by: l.decidedByName ?? "", raisedBy: l.enteredByName ?? "",
      outcome: l.state, submittedAt: new Date(l.createdAt).toISOString(), decidedAt: l.decidedAt ? new Date(l.decidedAt).toISOString() : undefined, amount: major(l.amountMinor), href: "/late-entries" });
  }
  const approvalsOut = ag.out("decided");
  const avg = (x: Num) => { x.avg_minutes = x.timed ? Math.round((x.minutes ?? 0) / x.timed) : 0; };
  avg(approvalsOut.total); approvalsOut.people.forEach(avg); approvalsOut.teams.forEach(avg); approvalsOut.months.forEach(avg);

  /* ── Invoices ── */
  const ig = grouper(() => ({ invoices: 0, amount: 0, outstanding: 0, overdue: 0, overdue_amount: 0, paid: 0, void: 0, collected: 0, payments: 0 }));
  const byStatus = new Map<string, Tally>();
  const invoiceRows: any[] = [];
  const now = Date.now();
  for (const inv of invoices as any[]) {
    const isVoid = inv.status === "void";
    const amount = isVoid ? 0 : major(inv.totalMinor), balance = isVoid ? 0 : major(inv.balanceMinor);
    const overdue = !isVoid && balance > 0 && inv.dueDate && new Date(inv.dueDate).getTime() < now;
    ig.add(String(inv.salespersonName ?? ""), crmOf(inv), inv.issueDate, { invoices: 1, amount, outstanding: balance, overdue: overdue ? 1 : 0, overdue_amount: overdue ? balance : 0,
      paid: inv.status === "paid" ? 1 : 0, void: isVoid ? 1 : 0 });
    const st = String(inv.status ?? "draft");
    tally(byStatus, st, major(inv.totalMinor));
    invoiceRows.push({ at: new Date(inv.issueDate).toISOString(), id: String(inv._id), number: inv.invoiceNumber, title: String(inv.customerName ?? ""), course: String(inv.enrolment?.course ?? ""),
      owner_id: String(inv.salespersonName ?? ""), owner: String(inv.salespersonName ?? ""), team: crmOf(inv), status: st, amount: major(inv.totalMinor), paid_amount: major(inv.amountPaidMinor),
      balance: major(inv.balanceMinor), due: inv.dueDate ? new Date(inv.dueDate).toISOString() : "", overdue: !!overdue, href: `/invoices/${inv._id}` });
  }
  const paymentRows: any[] = [];
  for (const inv of paidInvoices as any[]) {
    for (const p of inv.payments ?? []) {
      if (range && !inRange(p.paidOn)) continue;
      const amount = major(p.amountMinor);
      ig.add(String(inv.salespersonName ?? ""), crmOf(inv), p.paidOn, { collected: amount, payments: 1 });
      paymentRows.push({ at: new Date(p.paidOn).toISOString(), number: inv.invoiceNumber, title: String(inv.customerName ?? ""), method: String(p.method ?? ""), amount,
        owner: String(inv.salespersonName ?? ""), team: crmOf(inv), href: `/invoices/${inv._id}` });
    }
  }

  /* ── Budget allocation (the Budget page's figures) ── */
  const monthsIn = (() => {
    const out: string[] = [];
    const start = from ?? new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
    const end = to ?? new Date();
    const cur = new Date(Date.UTC(new Date(start.getTime() + UAE_MS).getUTCFullYear(), new Date(start.getTime() + UAE_MS).getUTCMonth(), 1));
    while (cur.getTime() <= end.getTime() + UAE_MS && out.length < 36) { out.push(cur.toISOString().slice(0, 7)); cur.setUTCMonth(cur.getUTCMonth() + 1); }
    return out;
  })();
  const bg = grouper(() => ({ allocated: 0, topups: 0, drawdowns: 0, spent: 0, available: 0, pending: 0 }));
  const budgetRows: any[] = [];
  const years = [...new Set(monthsIn.map((m) => Number(m.slice(0, 4))))];
  for (const year of years) {
    const rows = await getBudgetSummary(String(orgId), auth.userId, { year } as any, true);
    for (const r of rows) {
      if (!monthsIn.includes(r.period) || r.currency !== currency) continue;
      const add = { allocated: major(r.allocatedMinor), topups: major(r.approvedRequestsMinor), drawdowns: major(r.approvedDrawdownsMinor), spent: major(r.approvedExpensesMinor),
        available: major(r.availableMinor), pending: r.pendingRequests };
      bg.add(r.departmentName, r.period, `${r.period}-15T00:00:00Z`, add);
      budgetRows.push({ at: `${r.period}-01T00:00:00.000Z`, period: r.period, owner_id: r.departmentName, owner: r.departmentName, team: r.period, ...add });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    organizations: orgs.map((o) => ({ id: String(o._id), name: o.name, currency: o.baseCurrency || "AED" })),
    org: { id: String(orgId), name: org.name, currency },
    period: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
    rules: { delayMinutes: DELAY_MINUTES },
    expenses: { ...eg.out("amount"), categories: bars(byCategory), methods: bars(byMethod), rows: latest(expenseRows) },
    approvals: { ...approvalsOut, rows: latest(approvalRows) },
    invoices: { ...ig.out("amount"), statuses: bars(byStatus), payments: latest(paymentRows), rows: latest(invoiceRows) },
    budget: { ...bg.out("allocated"), rows: latest(budgetRows) },
    commission: { comingSoon: true, total: {}, people: [], teams: [], months: [], rows: [] },
  };
}
