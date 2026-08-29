import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { hrmsClient, type HrmsDepartment, type HrmsEmployee } from "../../lib/hrms-client";
import { Organization } from "../organization/organization.model";
import { Department } from "../department/department.model";
import { User } from "../user/user.model";
import { CommissionStructure } from "../commission/commission-structure.model";
import { CommissionRecord } from "../commission/commission-record.model";
import { Employee } from "../employee/employee.model";
import { Role } from "../role/role.model";
import { hashPassword } from "../../lib/password";
import { PayrollOrgLink } from "./org-link.model";
import { PayrollDeptLink } from "./dept-link.model";

const oid = (id: string) => new Types.ObjectId(id);
const norm = (s: string) => s.trim().toLowerCase();

/**
 * The mapping layer between HRMS and finance.
 *
 * The governing rule is **propose, never apply**. `previewSync` works out what
 * it thinks the answer is and returns it; nothing is written until a person
 * confirms it through `applySync`. That asymmetry is deliberate: the matching
 * evidence available here is a name and an email address, and both are things
 * people change. An automatic match that gets it wrong does not fail loudly —
 * it quietly points one employee's salary at another person's record, and the
 * first symptom is a payment.
 *
 * Note the absence of transactions. The production MongoDB URI has no replica
 * set, so `session.startTransaction()` would throw there while passing in dev.
 * `applySync` is therefore written to be re-runnable instead: every write is an
 * idempotent upsert keyed on the HRMS id, so a partial apply is fixed by
 * running it again rather than by rolling back.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type DeptState = "linked" | "proposed" | "unmatched";
export type EmpState = "linked" | "proposed" | "new" | "conflict" | "orphaned";

export interface DeptRow {
  hrmsDepartmentId: string;
  hrmsDepartmentName: string;
  state: DeptState;
  departmentId: string | null;
  departmentName: string | null;
  reason: string;
}

export interface EmpRow {
  hrmsEmployeeId: string;
  employeeCode: string;
  name: string;
  email: string;
  hrmsStatus: string;
  hasBankDetails: boolean;
  hrmsDepartmentId: string | null;
  state: EmpState;
  employeeId: string | null;
  userId: string | null;
  userName: string | null;
  issues: string[];
  changes: { field: string; from: string; to: string }[];
}

// ── Organization links ───────────────────────────────────────────────────────

export async function listHrmsOrganizations(orgId: string) {
  const [orgs, links] = await Promise.all([
    hrmsClient.organizations(),
    PayrollOrgLink.find({}).lean(),
  ]);
  const byHrmsId = new Map(links.map((l) => [l.hrmsOrgId, l]));
  return orgs.map((o) => {
    const link = byHrmsId.get(o.id);
    return {
      ...o,
      linked: Boolean(link),
      // An HRMS org already pointing at a *different* finance book is shown as
      // taken rather than hidden, so the reason it cannot be picked is visible.
      linkedToThisOrg: link ? String(link.organizationId) === orgId : false,
      linkId: link ? String(link._id) : null,
    };
  });
}

export async function listOrgLinks(orgId: string) {
  const links = await PayrollOrgLink.find({ organizationId: oid(orgId) }).sort({ hrmsOrgName: 1 }).lean();
  return links.map((l) => ({
    id: String(l._id),
    hrmsOrgId: l.hrmsOrgId,
    hrmsOrgName: l.hrmsOrgName,
    hrmsOrgCode: l.hrmsOrgCode,
    hrmsCurrency: l.hrmsCurrency,
    isActive: l.isActive,
    lastSyncedAt: l.lastSyncedAt ? (l.lastSyncedAt as Date).toISOString() : null,
    linkedByName: l.linkedByName,
  }));
}

/**
 * The role every mapped employee is given.
 *
 * No permissions at all. These accounts exist so that a person can be picked as
 * the salesperson on an invoice and own a commission structure — both of which
 * reference a User — not so they can use the finance application. Anybody who
 * genuinely needs access is given a real role by an administrator afterwards.
 */
async function payrollRoleId(orgId: string): Promise<Types.ObjectId> {
  const role = await Role.findOneAndUpdate(
    { organizationId: oid(orgId), key: "payroll-employee" },
    {
      $setOnInsert: {
        organizationId: oid(orgId),
        key: "payroll-employee",
        name: "Payroll employee",
        description: "Mapped from HRMS so they can be selected as a salesperson. No access to the application.",
        permissions: [],
      },
    },
    { upsert: true, new: true },
  );
  return role._id;
}

/**
 * Find or create the finance login that lets a mapped employee be a salesperson.
 *
 * An invoice's salesperson and a commission structure both reference a User, so
 * without one an employee cannot be selected on either — which is the whole
 * reason these accounts exist.
 *
 * They are not accounts anybody asked for, so they must not be usable. The
 * password is derived from random bytes that are discarded on the spot: there
 * is nothing to type, and giving somebody real access means an administrator
 * setting a password deliberately. Status stays "active" rather than
 * "suspended" because these are current employees, and suspended reads as
 * "this person was disabled".
 *
 * Returns null when there is no email to create one from. That is reported
 * rather than worked around — it is the one thing standing between an employee
 * and earning commission.
 */
async function ensureSalespersonLogin(
  orgId: string,
  employee: { name: string; email: string; employeeCode: string },
): Promise<{ userId: Types.ObjectId | null; created: boolean; reason?: string }> {
  const email = norm(employee.email);
  if (!email) {
    return {
      userId: null, created: false,
      reason: `${employee.employeeCode} has no email in HRMS, so no finance login could be created`,
    };
  }

  // Email is unique across the whole system, so an existing one is reused
  // rather than fought with.
  const existing = await User.findOne({ email }).lean();
  if (existing) {
    const inOrg = (existing.memberships ?? []).some((m) => String(m.organizationId) === orgId);
    if (!inOrg) {
      return {
        userId: null, created: false,
        reason: `${employee.employeeCode}: ${email} already belongs to an account outside this organization`,
      };
    }
    return { userId: existing._id, created: false };
  }

  const user = await User.create({
    name: employee.name,
    email,
    passwordHash: await hashPassword(`${crypto.randomUUID()}${crypto.randomUUID()}`),
    status: "active",
    memberships: [{ organizationId: oid(orgId), roleId: await payrollRoleId(orgId), status: "active" }],
  });
  return { userId: user._id, created: true };
}

/** The display name for an audit field, read from the record rather than the token. */
async function actorName(userId: string): Promise<string> {
  const user = await User.findById(oid(userId)).select("name").lean();
  return user?.name ?? "";
}

export async function createOrgLink(
  orgId: string,
  input: { hrmsOrgId: string },
  actor: { userId: string },
) {
  const org = await Organization.findById(oid(orgId)).lean();
  if (!org) throw new AppError("NOT_FOUND", "Organization not found");

  const remote = (await hrmsClient.organizations()).find((o) => o.id === input.hrmsOrgId);
  if (!remote) throw new AppError("NOT_FOUND", "That organization does not exist in HRMS");

  const existing = await PayrollOrgLink.findOne({ hrmsOrgId: input.hrmsOrgId }).lean();
  if (existing) {
    if (String(existing.organizationId) === orgId) {
      throw new AppError("CONFLICT", `"${remote.name}" is already linked to this organization`);
    }
    throw new AppError(
      "CONFLICT",
      `"${remote.name}" already feeds a different finance organization. An HRMS organization can only pay out of one book.`,
    );
  }

  const link = await PayrollOrgLink.create({
    organizationId: oid(orgId),
    hrmsOrgId: remote.id,
    hrmsOrgCode: remote.code,
    hrmsOrgName: remote.name,
    hrmsCurrency: remote.currency,
    linkedByUserId: oid(actor.userId),
    linkedByName: await actorName(actor.userId),
  });

  return {
    id: String(link._id),
    hrmsOrgId: link.hrmsOrgId,
    hrmsOrgName: link.hrmsOrgName,
    // Surfaced rather than thrown: a currency difference is legitimate (an
    // Indian entity paying out of an AED book) but it means payroll will need
    // an FX rate, and that must be a decision, not a surprise.
    currencyMismatch:
      norm(remote.currency) !== norm(org.baseCurrency ?? "AED")
        ? { hrms: remote.currency, finance: org.baseCurrency ?? "AED" }
        : null,
  };
}

export async function removeOrgLink(orgId: string, linkId: string) {
  const link = await PayrollOrgLink.findOne({ _id: oid(linkId), organizationId: oid(orgId) });
  if (!link) throw new AppError("NOT_FOUND", "Link not found");

  const mapped = await Employee.countDocuments({ organizationId: oid(orgId), hrmsOrgId: link.hrmsOrgId });
  if (mapped > 0) {
    throw new AppError(
      "CONFLICT",
      `${mapped} employee record(s) still map to this HRMS organization. Remove them before unlinking, or the payroll history loses what it pointed at.`,
    );
  }
  await PayrollDeptLink.deleteMany({ organizationId: oid(orgId), hrmsOrgId: link.hrmsOrgId });
  await link.deleteOne();
}

// ── Sync preview ─────────────────────────────────────────────────────────────

async function requireLink(orgId: string, hrmsOrgId: string) {
  const link = await PayrollOrgLink.findOne({ organizationId: oid(orgId), hrmsOrgId }).lean();
  if (!link) throw new AppError("NOT_FOUND", "That HRMS organization is not linked to this organization");
  if (!link.isActive) throw new AppError("VALIDATION_ERROR", "That link is inactive");
  return link;
}

function diffDepartments(
  hrmsDepts: HrmsDepartment[],
  deptLinks: { hrmsDepartmentId: string; departmentId: Types.ObjectId }[],
  financeDepts: { _id: Types.ObjectId; name: string }[],
): DeptRow[] {
  const linkByHrmsId = new Map(deptLinks.map((l) => [l.hrmsDepartmentId, String(l.departmentId)]));
  const financeById = new Map(financeDepts.map((d) => [String(d._id), d.name]));
  const financeByName = new Map(financeDepts.map((d) => [norm(d.name), d]));

  return hrmsDepts.map((d) => {
    const linkedTo = linkByHrmsId.get(d.id);
    if (linkedTo) {
      return {
        hrmsDepartmentId: d.id,
        hrmsDepartmentName: d.name,
        state: "linked" as const,
        departmentId: linkedTo,
        departmentName: financeById.get(linkedTo) ?? null,
        reason: "Already mapped",
      };
    }
    const byName = financeByName.get(norm(d.name));
    if (byName) {
      return {
        hrmsDepartmentId: d.id,
        hrmsDepartmentName: d.name,
        state: "proposed" as const,
        departmentId: String(byName._id),
        departmentName: byName.name,
        reason: "Name matches an existing finance department",
      };
    }
    return {
      hrmsDepartmentId: d.id,
      hrmsDepartmentName: d.name,
      state: "unmatched" as const,
      departmentId: null,
      departmentName: null,
      reason: "No finance department with this name — create one or pick a target",
    };
  });
}

export async function previewSync(orgId: string, hrmsOrgId: string) {
  const link = await requireLink(orgId, hrmsOrgId);

  const [hrmsDepts, hrmsEmps, financeDepts, deptLinks, existing, users] = await Promise.all([
    hrmsClient.departments(hrmsOrgId),
    // Leavers included: a terminated employee still needs their finance record
    // deactivated, and that only happens if they appear in the feed at all.
    hrmsClient.allEmployees(hrmsOrgId, { includeInactive: true }),
    Department.find({ organizationId: oid(orgId) }).select("name").lean(),
    PayrollDeptLink.find({ organizationId: oid(orgId), hrmsOrgId }).lean(),
    Employee.find({ organizationId: oid(orgId), hrmsOrgId }).lean(),
    User.find({ "memberships.organizationId": oid(orgId), status: "active" }).select("name email").lean(),
  ]);

  const departments = diffDepartments(hrmsDepts, deptLinks, financeDepts);
  const deptMapped = new Set(departments.filter((d) => d.state === "linked").map((d) => d.hrmsDepartmentId));

  const existingByHrmsId = new Map(existing.map((e) => [e.hrmsEmployeeId, e]));
  const usersByEmail = new Map<string, { _id: Types.ObjectId; name: string }[]>();
  for (const u of users) {
    if (!u.email) continue;
    const key = norm(u.email);
    if (!usersByEmail.has(key)) usersByEmail.set(key, []);
    usersByEmail.get(key)!.push({ _id: u._id, name: u.name });
  }
  const userTakenBy = new Map(
    existing.filter((e) => e.userId).map((e) => [String(e.userId), e.hrmsEmployeeId]),
  );

  // An email appearing twice in the HRMS feed cannot be used to match anyone:
  // whichever way it resolves, it is a coin toss between two real people.
  const emailCounts = new Map<string, number>();
  for (const e of hrmsEmps) {
    if (e.email) emailCounts.set(norm(e.email), (emailCounts.get(norm(e.email)) ?? 0) + 1);
  }

  const employees: EmpRow[] = hrmsEmps.map((e) => {
    const issues: string[] = [];
    const changes: { field: string; from: string; to: string }[] = [];
    const current = existingByHrmsId.get(e.id);

    if (!e.hasBankDetails) issues.push("No bank details in HRMS — cannot be paid");
    if (!e.departmentId) issues.push("No department in HRMS");
    else if (!deptMapped.has(e.departmentId)) issues.push("Department is not mapped yet");
    if (!e.email) issues.push("No email in HRMS — cannot be matched to a finance login automatically");

    if (current) {
      if (current.name !== e.name) changes.push({ field: "name", from: current.name, to: e.name });
      if (norm(current.email ?? "") !== norm(e.email)) {
        changes.push({ field: "email", from: current.email ?? "", to: e.email });
      }
      if (current.employeeCode !== e.employeeCode) {
        changes.push({ field: "employeeCode", from: current.employeeCode, to: e.employeeCode });
      }
      // Somebody mapped before every employee became a salesperson, or whose
      // login could not be created last time. Counted as a change so the row
      // does not sit quietly at "leave alone" for ever — without this it looks
      // up to date while being unable to earn commission.
      if (!current.userId) {
        changes.push({
          field: "salesperson login",
          from: "none",
          to: e.email ? "will be created" : "needs an email in HRMS",
        });
      }
      const shouldBeActive = e.status !== "terminated";
      if (shouldBeActive !== (current.status === "active")) {
        changes.push({ field: "status", from: current.status, to: shouldBeActive ? "active" : "inactive" });
      }
      return {
        hrmsEmployeeId: e.id, employeeCode: e.employeeCode, name: e.name, email: e.email,
        hrmsStatus: e.status, hasBankDetails: e.hasBankDetails, hrmsDepartmentId: e.departmentId,
        state: "linked", employeeId: String(current._id),
        userId: current.userId ? String(current.userId) : null, userName: null,
        issues, changes,
      };
    }

    const emailKey = e.email ? norm(e.email) : "";
    if (emailKey && (emailCounts.get(emailKey) ?? 0) > 1) {
      issues.push("Two HRMS employees share this email — resolve it in HRMS first");
      return {
        hrmsEmployeeId: e.id, employeeCode: e.employeeCode, name: e.name, email: e.email,
        hrmsStatus: e.status, hasBankDetails: e.hasBankDetails, hrmsDepartmentId: e.departmentId,
        state: "conflict", employeeId: null, userId: null, userName: null, issues, changes,
      };
    }

    const candidates = emailKey ? (usersByEmail.get(emailKey) ?? []) : [];
    if (candidates.length === 1) {
      const u = candidates[0]!;
      const takenBy = userTakenBy.get(String(u._id));
      if (takenBy && takenBy !== e.id) {
        issues.push("That finance login is already mapped to a different employee");
        return {
          hrmsEmployeeId: e.id, employeeCode: e.employeeCode, name: e.name, email: e.email,
          hrmsStatus: e.status, hasBankDetails: e.hasBankDetails, hrmsDepartmentId: e.departmentId,
          state: "conflict", employeeId: null, userId: String(u._id), userName: u.name, issues, changes,
        };
      }
      return {
        hrmsEmployeeId: e.id, employeeCode: e.employeeCode, name: e.name, email: e.email,
        hrmsStatus: e.status, hasBankDetails: e.hasBankDetails, hrmsDepartmentId: e.departmentId,
        state: "proposed", employeeId: null, userId: String(u._id), userName: u.name, issues, changes,
      };
    }
    if (candidates.length > 1) {
      issues.push("Several finance logins share this email — pick one by hand");
      return {
        hrmsEmployeeId: e.id, employeeCode: e.employeeCode, name: e.name, email: e.email,
        hrmsStatus: e.status, hasBankDetails: e.hasBankDetails, hrmsDepartmentId: e.departmentId,
        state: "conflict", employeeId: null, userId: null, userName: null, issues, changes,
      };
    }

    // No finance login, and none needed. Most of the payroll is this row.
    return {
      hrmsEmployeeId: e.id, employeeCode: e.employeeCode, name: e.name, email: e.email,
      hrmsStatus: e.status, hasBankDetails: e.hasBankDetails, hrmsDepartmentId: e.departmentId,
      state: "new", employeeId: null, userId: null, userName: null, issues, changes,
    };
  });

  // Records finance holds that HRMS no longer reports at all — a hard-deleted
  // employee, or one moved to another org. Never auto-removed: the payroll
  // history points at them.
  const feedIds = new Set(hrmsEmps.map((e) => e.id));
  const orphaned: EmpRow[] = existing
    .filter((e) => !feedIds.has(e.hrmsEmployeeId))
    .map((e) => ({
      hrmsEmployeeId: e.hrmsEmployeeId, employeeCode: e.employeeCode, name: e.name,
      email: e.email ?? "", hrmsStatus: e.hrmsStatus ?? "", hasBankDetails: e.hasBankDetails,
      hrmsDepartmentId: e.hrmsDepartmentId || null, state: "orphaned",
      employeeId: String(e._id), userId: e.userId ? String(e.userId) : null, userName: null,
      issues: ["No longer present in the HRMS feed — deactivate, or check the org link"],
      changes: [],
    }));

  const all = [...employees, ...orphaned];
  return {
    hrmsOrgId,
    hrmsOrgName: link.hrmsOrgName,
    departments,
    employees: all,
    summary: {
      departments: {
        linked: departments.filter((d) => d.state === "linked").length,
        proposed: departments.filter((d) => d.state === "proposed").length,
        unmatched: departments.filter((d) => d.state === "unmatched").length,
      },
      employees: {
        linked: all.filter((e) => e.state === "linked").length,
        proposed: all.filter((e) => e.state === "proposed").length,
        new: all.filter((e) => e.state === "new").length,
        conflict: all.filter((e) => e.state === "conflict").length,
        orphaned: orphaned.length,
      },
      blockers: {
        noBankDetails: all.filter((e) => e.state !== "orphaned" && !e.hasBankDetails).length,
        unmappedDepartment: all.filter((e) => e.issues.some((i) => i.startsWith("Department is not mapped"))).length,
      },
    },
  };
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface SyncDecision {
  kind: "department" | "employee";
  hrmsId: string;
  /**
   * "create" imports and gives them a salesperson login; "import_only" imports
   * without one, for somebody who should be on the payroll but never named on
   * an invoice.
   */
  action: "link" | "create" | "import_only" | "deactivate" | "skip";
  /** For a department `link`: the finance department to point at. */
  targetDepartmentId?: string;
  /** For an employee `link`: the finance login to attach. */
  targetUserId?: string;
}

export async function applySync(
  orgId: string,
  hrmsOrgId: string,
  decisions: SyncDecision[],
  actor: { userId: string },
) {
  await requireLink(orgId, hrmsOrgId);

  // Re-read from HRMS rather than trusting names round-tripped through the
  // browser: the preview the operator saw may be minutes old, and the values
  // written here are the ones payroll will use.
  const [hrmsDepts, hrmsEmps] = await Promise.all([
    hrmsClient.departments(hrmsOrgId),
    hrmsClient.allEmployees(hrmsOrgId, { includeInactive: true }),
  ]);
  const deptById = new Map(hrmsDepts.map((d) => [d.id, d]));
  const empById = new Map(hrmsEmps.map((e) => [e.id, e]));

  const result = {
    departmentsLinked: 0, departmentsCreated: 0,
    employeesLinked: 0, employeesCreated: 0, employeesDeactivated: 0,
    /** Salesperson logins minted for people who had none. */
    loginsCreated: 0,
    skipped: 0,
    errors: [] as { hrmsId: string; message: string }[],
    /** Non-fatal: the employee is mapped, but could not be made a salesperson. */
    warnings: [] as string[],
  };

  // Departments first: an employee's department mapping is resolved from them.
  for (const d of decisions.filter((x) => x.kind === "department")) {
    try {
      if (d.action === "skip") { result.skipped++; continue; }
      const remote = deptById.get(d.hrmsId);
      if (!remote) throw new AppError("NOT_FOUND", "Department no longer exists in HRMS");

      let departmentId: Types.ObjectId;
      if (d.action === "create") {
        const created = await Department.findOneAndUpdate(
          { organizationId: oid(orgId), name: remote.name },
          { $setOnInsert: { organizationId: oid(orgId), name: remote.name, description: `Mapped from HRMS (${remote.code || remote.name})` } },
          { new: true, upsert: true },
        );
        departmentId = created._id;
        result.departmentsCreated++;
      } else {
        if (!d.targetDepartmentId) throw new AppError("VALIDATION_ERROR", "targetDepartmentId is required to link");
        const target = await Department.findOne({ _id: oid(d.targetDepartmentId), organizationId: oid(orgId) }).lean();
        if (!target) throw new AppError("NOT_FOUND", "Target finance department not found");
        departmentId = target._id;
        result.departmentsLinked++;
      }

      await PayrollDeptLink.findOneAndUpdate(
        { hrmsOrgId, hrmsDepartmentId: remote.id },
        {
          $set: { organizationId: oid(orgId), departmentId, hrmsDepartmentName: remote.name, isActive: true, linkedByUserId: oid(actor.userId) },
        },
        { upsert: true },
      );
    } catch (err) {
      result.errors.push({ hrmsId: d.hrmsId, message: (err as Error).message });
    }
  }

  const deptLinks = await PayrollDeptLink.find({ organizationId: oid(orgId), hrmsOrgId }).lean();
  const financeDeptByHrmsId = new Map(deptLinks.map((l) => [l.hrmsDepartmentId, l.departmentId]));

  for (const d of decisions.filter((x) => x.kind === "employee")) {
    try {
      if (d.action === "skip") { result.skipped++; continue; }

      if (d.action === "deactivate") {
        const res = await Employee.updateOne(
          { organizationId: oid(orgId), hrmsOrgId, hrmsEmployeeId: d.hrmsId },
          { $set: { status: "inactive", lastSyncedAt: new Date() } },
        );
        if (res.matchedCount) result.employeesDeactivated++;
        continue;
      }

      const remote = empById.get(d.hrmsId);
      if (!remote) throw new AppError("NOT_FOUND", "Employee no longer exists in the HRMS feed");

      if (d.targetUserId) {
        const user = await User.findOne({ _id: oid(d.targetUserId), "memberships.organizationId": oid(orgId) }).lean();
        if (!user) throw new AppError("NOT_FOUND", "Target finance login not found in this organization");
        const clash = await Employee.findOne({
          organizationId: oid(orgId), userId: oid(d.targetUserId), hrmsEmployeeId: { $ne: remote.id },
        }).lean();
        if (clash) throw new AppError("CONFLICT", `That finance login already maps to ${clash.name} (${clash.employeeCode})`);
      }

      const existed = await Employee.findOne({ hrmsOrgId, hrmsEmployeeId: remote.id }).lean();

      /**
       * Every mapped employee gets a finance login, whether or not one was
       * picked for them.
       *
       * An invoice's salesperson and a commission structure both reference a
       * User, so an employee without one cannot be selected on either — they
       * would be on the payroll but unable to earn anything through it. The
       * account carries no permissions and no usable password; it exists to be
       * chosen from a list.
       *
       * A failure here does not fail the import. The employee is still mapped
       * and still gets paid — they simply cannot be a salesperson yet, and the
       * reason is reported so somebody can fix the email in HRMS and re-sync.
       */
      let userId = d.targetUserId ? oid(d.targetUserId) : (existed?.userId ?? null);
      // "import_only" declines the login. An existing one is left alone rather
      // than stripped — declining to create is not the same as taking away.
      if (!userId && d.action !== "import_only") {
        const login = await ensureSalespersonLogin(orgId, {
          name: remote.name, email: remote.email, employeeCode: remote.employeeCode,
        });
        if (login.userId) {
          userId = login.userId;
          if (login.created) result.loginsCreated++;
        } else if (login.reason) {
          result.warnings.push(login.reason);
        }
      }

      await Employee.findOneAndUpdate(
        { hrmsOrgId, hrmsEmployeeId: remote.id },
        {
          $set: {
            organizationId: oid(orgId),
            employeeCode: remote.employeeCode,
            name: remote.name,
            email: remote.email,
            hrmsDepartmentId: remote.departmentId ?? "",
            departmentId: remote.departmentId ? (financeDeptByHrmsId.get(remote.departmentId) ?? null) : null,
            designation: remote.designation,
            employmentType: remote.employmentType,
            currency: remote.currency,
            joiningDate: remote.joiningDate ? new Date(remote.joiningDate) : null,
            hrmsStatus: remote.status,
            status: remote.status === "terminated" ? "inactive" : "active",
            hasBankDetails: remote.hasBankDetails,
            lastSyncedAt: new Date(),
            ...(userId ? { userId } : {}),
          },
        },
        { upsert: true, new: true },
      );

      if (existed) result.employeesLinked++;
      else result.employeesCreated++;
    } catch (err) {
      result.errors.push({ hrmsId: d.hrmsId, message: (err as Error).message });
    }
  }

  await PayrollOrgLink.updateOne({ organizationId: oid(orgId), hrmsOrgId }, { $set: { lastSyncedAt: new Date() } });
  return result;
}

// ── Mapped roster ────────────────────────────────────────────────────────────

/**
 * The mapped roster, and which of those people can earn commission.
 *
 * Being mapped and being a salesperson are not the same thing, and the
 * difference matters: a mapped employee is somebody payroll knows about, while
 * a salesperson is one of the minority who also holds a finance login and has a
 * commission structure against it. Most of a payroll is the former.
 */
export async function listEmployees(
  orgId: string,
  query: {
    hrmsOrgId?: string; status?: string; search?: string;
    /** "salesperson" narrows to people who can actually earn commission. */
    role?: string;
    page?: number; limit?: number;
  },
) {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));
  const filter: Record<string, unknown> = { organizationId: oid(orgId) };
  if (query.hrmsOrgId) filter.hrmsOrgId = query.hrmsOrgId;
  if (query.status) filter.status = query.status;
  if (query.search) {
    const rx = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { employeeCode: rx }, { email: rx }];
  }

  // Commission hangs off the finance login, not off the employee record, so the
  // set of salespeople is worked out here rather than stored on the row —
  // storing it would go stale the moment somebody's structure changed.
  const structures = await CommissionStructure.find({ organizationId: oid(orgId), isActive: true })
    .select("salespersonId")
    .lean();
  const salesUserIds = new Set(structures.map((s) => String(s.salespersonId)));

  // "Salespeople" now means everybody who can be picked on an invoice, so the
  // useful filter is the opposite one: who still has no rate configured.
  if (query.role === "salesperson") filter.userId = { $ne: null };
  if (query.role === "no_commission_rate") {
    const ids = [...salesUserIds].map((id) => oid(id));
    filter.userId = { $ne: null, $nin: ids };
  }

  const [rows, total] = await Promise.all([
    Employee.find(filter)
      .populate("departmentId", "name")
      .sort({ employeeCode: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Employee.countDocuments(filter),
  ]);

  // Only for the people on this page, and only those who could have any.
  const pageSalesIds = rows.filter((e) => e.userId && salesUserIds.has(String(e.userId))).map((e) => e.userId);
  const commissionByUser = new Map<string, { earnedMinor: number; paidMinor: number }>();
  if (pageSalesIds.length) {
    const agg = await CommissionRecord.aggregate([
      { $match: { organizationId: oid(orgId), salespersonId: { $in: pageSalesIds }, status: { $ne: "cancelled" } } },
      {
        $group: {
          _id: "$salespersonId",
          earnedMinor: { $sum: { $cond: [{ $eq: ["$status", "earned"] }, "$commissionMinor", 0] } },
          paidMinor: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$commissionMinor", 0] } },
        },
      },
    ]);
    for (const a of agg as Array<{ _id: Types.ObjectId; earnedMinor: number; paidMinor: number }>) {
      commissionByUser.set(String(a._id), { earnedMinor: a.earnedMinor, paidMinor: a.paidMinor });
    }
  }

  return {
    data: rows.map((e) => ({
      id: String(e._id),
      hrmsOrgId: e.hrmsOrgId,
      hrmsEmployeeId: e.hrmsEmployeeId,
      employeeCode: e.employeeCode,
      name: e.name,
      email: e.email,
      designation: e.designation,
      department: e.departmentId ? (e.departmentId as unknown as { name: string }).name : null,
      userId: e.userId ? String(e.userId) : null,
      status: e.status,
      hrmsStatus: e.hrmsStatus,
      // The pre-payroll health check, answered per row rather than in aggregate.
      payable: e.status === "active" && e.hasBankDetails && Boolean(e.departmentId),
      hasBankDetails: e.hasBankDetails,
      /**
       * Every mapped employee is a salesperson — that is what the login is for.
       * Whether they have a *rate* yet is a separate question, and conflating
       * the two made people who simply had no commission structure look as
       * though they were not salespeople at all.
       */
      isSalesperson: Boolean(e.userId),
      hasCommissionStructure: Boolean(e.userId && salesUserIds.has(String(e.userId))),
      commissionEarnedMinor: commissionByUser.get(String(e.userId ?? ""))?.earnedMinor ?? 0,
      commissionPaidMinor: commissionByUser.get(String(e.userId ?? ""))?.paidMinor ?? 0,
      lastSyncedAt: e.lastSyncedAt ? (e.lastSyncedAt as Date).toISOString() : null,
    })),
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}
