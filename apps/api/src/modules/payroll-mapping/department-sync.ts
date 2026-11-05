import { Types } from "mongoose";
import { logger } from "../../lib/logger";
import { hrmsClient, type HrmsDepartment } from "../../lib/hrms-client";
import { Department } from "../department/department.model";
import { Employee } from "../employee/employee.model";
import { PayrollOrgLink } from "./org-link.model";
import { PayrollDeptLink } from "./dept-link.model";

/**
 * Finance's departments kept as HRMS has them (the user, 2026-11-05: "get all departments to finance and update the
 * department according to HRMS also").
 *
 * Before, a department came over only when somebody mapped it by hand on Payroll → Mapping, and never followed HRMS
 * after: renamed there, it kept its old name here; a new one did not appear until mapped. Now, for every HRMS
 * organization linked to a finance one, each of its departments is:
 *   - linked already: renamed here to HRMS's name — unless another department here has that name, or two HRMS
 *     departments by different names feed this one (they would rename it back and forth): then it is left, and said;
 *   - not linked, with a department here of the same name: linked to it;
 *   - neither: made here, and linked — not one HRMS has marked inactive.
 * Then each payroll employee's department here follows their department in HRMS, where that one is linked. Nothing is
 * deleted: a department made here by hand, or one HRMS no longer has, stays. A finance login's own department is left
 * as an administrator set it.
 *
 * Every hour (jobs/department-sync.worker.ts) and from Admin → Departments → Sync from HRMS.
 */

export interface DepartmentSyncResult {
  /** HRMS organizations read. */
  organizations: number;
  created: Array<{ name: string; from: string }>;
  linked: Array<{ name: string; from: string }>;
  renamed: Array<{ from: string; to: string }>;
  /** Payroll employees whose department here changed to follow HRMS. */
  peopleMoved: number;
  /** HRMS departments marked inactive, and linked to nothing here: not made. */
  inactiveLeft: number;
  /** What could not be done, and why. */
  problems: string[];
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const clean = (s: string) => s.trim().replace(/\s+/g, " ");

export async function syncDepartmentsFromHrms(
  opts: { organizationId?: string; actorId?: string; withPeople?: boolean } = {},
): Promise<DepartmentSyncResult> {
  const result: DepartmentSyncResult = { organizations: 0, created: [], linked: [], renamed: [], peopleMoved: 0, inactiveLeft: 0, problems: [] };
  if (!hrmsClient.isConfigured()) {
    result.problems.push("HRMS is not connected to finance on this server");
    return result;
  }
  const links = await PayrollOrgLink.find({
    isActive: true,
    ...(opts.organizationId ? { organizationId: new Types.ObjectId(opts.organizationId) } : {}),
  }).lean();

  for (const link of links) {
    const org = link.organizationId as Types.ObjectId;
    const from = String(link.hrmsOrgName || link.hrmsOrgId);
    let hrmsDepts: HrmsDepartment[];
    try {
      hrmsDepts = await hrmsClient.departments(link.hrmsOrgId);
    } catch (err) {
      result.problems.push(`${from}: HRMS couldn't be read — ${(err as Error).message}`);
      continue;
    }
    result.organizations++;

    for (const d of hrmsDepts) {
      try {
        await syncOne(org, link.hrmsOrgId, from, d, result, opts.actorId);
      } catch (err) {
        result.problems.push(`${from} · ${d.name}: ${(err as Error).message}`);
      }
    }

    if (opts.withPeople !== false) {
      try {
        result.peopleMoved += await movePeople(org, link.hrmsOrgId);
      } catch (err) {
        result.problems.push(`${from}: people's departments couldn't be brought into line — ${(err as Error).message}`);
      }
    }
  }
  return result;
}

async function syncOne(
  org: Types.ObjectId,
  hrmsOrgId: string,
  from: string,
  d: HrmsDepartment,
  result: DepartmentSyncResult,
  actorId?: string,
): Promise<void> {
  const name = clean(d.name ?? "");
  if (!name) return;
  const link = await PayrollDeptLink.findOne({ hrmsOrgId, hrmsDepartmentId: d.id });
  const target = link ? await Department.findOne({ _id: link.departmentId, organizationId: org }) : null;

  if (link && target) {
    if (link.hrmsDepartmentName !== name || !link.isActive) {
      link.hrmsDepartmentName = name;
      link.isActive = true;
      await link.save();
    }
    if (target.name === name) return;
    // Fed by HRMS departments of other names too: renaming would only be undone by the next of them.
    const feeding = await PayrollDeptLink.find({ departmentId: target._id, isActive: true }).select("hrmsDepartmentName").lean();
    const names = new Set(feeding.map((f) => norm(f.hrmsDepartmentName ?? "")).filter(Boolean));
    if (names.size > 1) {
      result.problems.push(`"${target.name}" is fed by ${names.size} HRMS departments of different names (${feeding.map((f) => f.hrmsDepartmentName).join(", ")}) — not renamed`);
      return;
    }
    const clash = await Department.findOne({ organizationId: org, _id: { $ne: target._id } }).where("name").regex(new RegExp(`^\\s*${escape(name)}\\s*$`, "i")).select("name").lean();
    if (clash) {
      result.problems.push(`"${target.name}" is "${name}" in HRMS, but there is already a department "${clash.name}" here — not renamed`);
      return;
    }
    const was = target.name;
    target.name = name;
    await target.save();
    result.renamed.push({ from: was, to: name });
    return;
  }

  // Not linked yet (or linked to a department since deleted here).
  if ((d.status ?? "active") !== "active") {
    result.inactiveLeft++;
    return;
  }
  const same = await Department.findOne({ organizationId: org }).where("name").regex(new RegExp(`^\\s*${escape(name)}\\s*$`, "i"));
  let departmentId: Types.ObjectId;
  if (same) {
    departmentId = same._id as Types.ObjectId;
    result.linked.push({ name: same.name, from });
  } else {
    const made = await Department.findOneAndUpdate(
      { organizationId: org, name },
      { $setOnInsert: { organizationId: org, name, description: `From HRMS (${from}${d.code ? ` · ${d.code}` : ""})` } },
      { new: true, upsert: true },
    );
    departmentId = made._id as Types.ObjectId;
    result.created.push({ name, from });
  }
  await PayrollDeptLink.findOneAndUpdate(
    { hrmsOrgId, hrmsDepartmentId: d.id },
    {
      $set: {
        organizationId: org, departmentId, hrmsDepartmentName: name, isActive: true,
        ...(actorId ? { linkedByUserId: new Types.ObjectId(actorId) } : {}),
      },
    },
    { upsert: true },
  );
  // Linked to one here spelt otherwise ("marketing" for "Marketing"): it takes HRMS's spelling now, as a linked one does.
  if (same && same.name !== name) await syncOne(org, hrmsOrgId, from, d, result, actorId);
}

/** Each payroll employee's department here, as their department in HRMS — where that one is linked. */
async function movePeople(org: Types.ObjectId, hrmsOrgId: string): Promise<number> {
  const employees = await Employee.find({ organizationId: org, hrmsOrgId }).select("hrmsEmployeeId departmentId hrmsDepartmentId").lean();
  if (!employees.length) return 0;
  const [remote, links] = await Promise.all([
    hrmsClient.allEmployees(hrmsOrgId, { includeInactive: true }),
    PayrollDeptLink.find({ hrmsOrgId, isActive: true }).select("hrmsDepartmentId departmentId").lean(),
  ]);
  const deptOf = new Map(links.map((l) => [l.hrmsDepartmentId, l.departmentId as Types.ObjectId]));
  const remoteById = new Map(remote.map((e) => [e.id, e]));
  let moved = 0;
  for (const e of employees) {
    const r = remoteById.get(e.hrmsEmployeeId);
    // No department in HRMS, or one linked to nothing here: what they have here stays.
    const want = r?.departmentId ? deptOf.get(r.departmentId) : undefined;
    if (!r?.departmentId || !want) continue;
    if (String(e.departmentId ?? "") === String(want) && e.hrmsDepartmentId === r.departmentId) continue;
    await Employee.updateOne({ _id: e._id }, { $set: { departmentId: want, hrmsDepartmentId: r.departmentId } });
    if (String(e.departmentId ?? "") !== String(want)) moved++;
  }
  return moved;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** For a log line: what a pass did. */
export function describeSync(r: DepartmentSyncResult): string {
  const parts = [
    r.created.length ? `${r.created.length} made` : "",
    r.linked.length ? `${r.linked.length} linked` : "",
    r.renamed.length ? `${r.renamed.length} renamed` : "",
    r.peopleMoved ? `${r.peopleMoved} people moved` : "",
    r.problems.length ? `${r.problems.length} problem(s)` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing to change";
}

export function logSync(r: DepartmentSyncResult): void {
  if (r.created.length || r.linked.length || r.renamed.length || r.peopleMoved || r.problems.length) {
    logger.info({ ...r }, `Departments from HRMS: ${describeSync(r)}`);
  }
}
