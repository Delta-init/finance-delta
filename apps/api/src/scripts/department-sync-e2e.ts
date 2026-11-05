/**
 * Finance's departments kept as HRMS has them (payroll-mapping/department-sync.ts, the user 2026-11-05), against a
 * scratch database and a stand-in HRMS.
 *
 * What it proves: a linked department renamed as HRMS has it; an unlinked one linked to the department here of the
 * same name (whatever its case); a new one made and linked; one HRMS marked inactive not made; a rename that would
 * clash with another department here, and one fed by two HRMS departments of different names, left and said;
 * payroll employees moved to their HRMS department's, not one with no department or an unlinked one; an HRMS that
 * can't be read said, the rest synced; a second pass changes nothing; only the organization asked for; departments
 * made here by hand untouched; the list says which follow HRMS.
 *
 * Run through scripts/department-sync-e2e.sh (throwaway mongod, no .env anywhere).
 */
import { mock } from "bun:test";
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}

// The stand-in HRMS: departments and people per HRMS organization, changed between passes.
const hrms: Record<string, { departments: any[]; employees: any[]; down?: boolean }> = {};
mock.module("../lib/hrms-client", () => ({
  hrmsClient: {
    isConfigured: () => true,
    departments: async (org: string) => {
      if (!hrms[org] || hrms[org]!.down) throw new Error("HRMS is not answering");
      return hrms[org]!.departments;
    },
    allEmployees: async (org: string) => hrms[org]?.employees ?? [],
  },
}));
const { syncDepartmentsFromHrms } = await import("../modules/payroll-mapping/department-sync");
const { listDepartments } = await import("../modules/department/department.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const show = (v: unknown) => String(JSON.stringify(v)).slice(0, 700);

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;

const ORG = new Types.ObjectId(), OTHER_ORG = new Types.ObjectId();
await db.collection("organizations").insertMany([{ _id: ORG, name: "Delta HQ" }, { _id: OTHER_ORG, name: "Delta Bangalore" }] as any[]);
const dept = (name: string, org = ORG) => ({ _id: new Types.ObjectId(), organizationId: org, name, description: "", createdAt: new Date(), updatedAt: new Date() });
const SALES = dept("Sales Team"), MKT = dept("marketing"), ACCOUNTS = dept("Accounts"), FINANCE = dept("Finance"), OPS = dept("Operations"), HAND = dept("Made by hand");
const BLR_SALES = dept("Sales BLR", OTHER_ORG);
await db.collection("departments").insertMany([SALES, MKT, ACCOUNTS, FINANCE, OPS, HAND, BLR_SALES] as any[]);
await db.collection("payrollorglinks").insertMany([
  { organizationId: ORG, hrmsOrgId: "hA", hrmsOrgName: "Delta Training", isActive: true },
  { organizationId: ORG, hrmsOrgId: "hB", hrmsOrgName: "Delta Media", isActive: true },
  { organizationId: ORG, hrmsOrgId: "hC", hrmsOrgName: "Delta Down", isActive: true },
  { organizationId: OTHER_ORG, hrmsOrgId: "hX", hrmsOrgName: "Delta India", isActive: true },
] as any[]);
const link = (hrmsOrgId: string, hrmsDepartmentId: string, hrmsDepartmentName: string, departmentId: Types.ObjectId, org = ORG) =>
  ({ organizationId: org, hrmsOrgId, hrmsDepartmentId, hrmsDepartmentName, departmentId, isActive: true });
await db.collection("payrolldeptlinks").insertMany([
  link("hA", "d1", "Sales Team", SALES._id),
  link("hA", "d5", "Accounts", ACCOUNTS._id),
  link("hA", "d6", "Ops", OPS._id), link("hB", "b1", "Operations Team", OPS._id),
  link("hX", "x1", "Sales BLR", BLR_SALES._id, OTHER_ORG),
] as any[]);
const D = (id: string, name: string, status = "active") => ({ id, name, code: "", status, organizationId: null });
hrms.hA = {
  departments: [D("d1", "Sales"), D("d2", "Marketing"), D("d3", "Academic"), D("d4", "Old Dept", "inactive"), D("d5", "Finance"), D("d6", "Ops")],
  employees: [
    { id: "e1", departmentId: "d3" }, { id: "e2", departmentId: null }, { id: "e3", departmentId: "d4" }, { id: "e4", departmentId: "d1" },
  ],
};
hrms.hB = { departments: [D("b1", "Operations Team")], employees: [] };
hrms.hC = { departments: [], employees: [], down: true };
hrms.hX = { departments: [D("x1", "Sales India"), D("x2", "Support")], employees: [] };
const E = (hrmsEmployeeId: string, departmentId: Types.ObjectId | null, hrmsDepartmentId: string) => ({
  _id: new Types.ObjectId(), organizationId: ORG, hrmsOrgId: "hA", hrmsEmployeeId, employeeCode: hrmsEmployeeId.toUpperCase(), name: hrmsEmployeeId, departmentId, hrmsDepartmentId, status: "active",
});
const E1 = E("e1", SALES._id, "d1"), E2 = E("e2", HAND._id, ""), E3 = E("e3", SALES._id, "d1"), E4 = E("e4", SALES._id, "d1");
await db.collection("employees").insertMany([E1, E2, E3, E4] as any[]);

const deptNamed = async (name: string, org = ORG) => db.collection("departments").findOne({ organizationId: org, name }) as Promise<any>;
const emp = async (e: any) => db.collection("employees").findOne({ _id: e._id }) as Promise<any>;
const snap = async () => JSON.stringify(await db.collection("departments").find({}).sort({ _id: 1 }).project({ updatedAt: 0 }).toArray())
  + JSON.stringify(await db.collection("payrolldeptlinks").find({}).sort({ _id: 1 }).project({ updatedAt: 0 }).toArray())
  + JSON.stringify(await db.collection("employees").find({}).sort({ _id: 1 }).project({ updatedAt: 0 }).toArray());

try {
  step("1. A pass for Delta HQ");
  const blrBefore = JSON.stringify(await db.collection("departments").find({ organizationId: OTHER_ORG }).toArray());
  let r = await syncDepartmentsFromHrms({ organizationId: String(ORG) });
  check("the HRMS organizations read: the two that answered", r.organizations === 2, show(r));
  check("a linked one renamed as HRMS has it: Sales Team → Sales", r.renamed.some((x) => x.from === "Sales Team" && x.to === "Sales") && !!(await deptNamed("Sales")) && String((await deptNamed("Sales"))._id) === String(SALES._id), show(r.renamed));
  check("an unlinked one linked to the one here of the same name, whatever its case", r.linked.some((x) => x.name === "marketing")
    && !!(await db.collection("payrolldeptlinks").findOne({ hrmsOrgId: "hA", hrmsDepartmentId: "d2", departmentId: MKT._id })), show(r.linked));
  const academic = await deptNamed("Academic");
  check("a new one made, and linked", r.created.some((x) => x.name === "Academic") && !!academic && /From HRMS \(Delta Training/.test(academic.description)
    && !!(await db.collection("payrolldeptlinks").findOne({ hrmsDepartmentId: "d3", departmentId: academic?._id })), show(r.created));
  check("one HRMS marked inactive: not made", r.inactiveLeft === 1 && !(await deptNamed("Old Dept")));
  check("a rename that would clash with another department here: left, and said", !!(await deptNamed("Accounts")) && r.problems.some((p) => /"Accounts" is "Finance" in HRMS, but there is already a department "Finance"/.test(p)), show(r.problems));
  check("one fed by two HRMS departments of different names: left, and said", !!(await deptNamed("Operations")) && r.problems.some((p) => /"Operations" is fed by 2 HRMS departments/.test(p)), show(r.problems));
  check("an HRMS that can't be read: said, the rest synced", r.problems.some((p) => /Delta Down: HRMS couldn't be read/.test(p)));
  check("people moved to their HRMS department's: the one now in Academic", String((await emp(E1)).departmentId) === String(academic?._id) && (await emp(E1)).hrmsDepartmentId === "d3" && r.peopleMoved === 1, show({ moved: r.peopleMoved, e1: await emp(E1) }));
  check("…not one with no department in HRMS, nor one in an unlinked department", String((await emp(E2)).departmentId) === String(HAND._id) && String((await emp(E3)).departmentId) === String(SALES._id));
  check("…and one already in theirs stays", String((await emp(E4)).departmentId) === String(SALES._id));
  check("a department made here by hand: untouched", !!(await deptNamed("Made by hand")));
  check("another organization's: untouched", JSON.stringify(await db.collection("departments").find({ organizationId: OTHER_ORG }).toArray()) === blrBefore);

  step("2. Again: nothing to change");
  const before = await snap();
  r = await syncDepartmentsFromHrms({ organizationId: String(ORG) });
  check("nothing made, linked, renamed or moved", !r.created.length && !r.linked.length && !r.renamed.length && !r.peopleMoved, show(r));
  check("…nothing written", (await snap()) === before);

  step("3. HRMS renames and adds; the hourly pass, every organization");
  hrms.hA.departments.find((d) => d.id === "d3")!.name = "Academic Department";
  hrms.hA.departments.push(D("d7", "Media"));
  hrms.hC.down = false;
  r = await syncDepartmentsFromHrms();
  check("renamed with HRMS, made the new one", r.renamed.some((x) => x.from === "Academic" && x.to === "Academic Department") && r.created.some((x) => x.name === "Media"), show(r));
  check("the other organization's too: renamed and made in its own", !!(await deptNamed("Sales India", OTHER_ORG)) && !!(await deptNamed("Support", OTHER_ORG)) && !(await deptNamed("Support")), show(r));
  check("the HRMS that answers now: read, nothing wrong", r.organizations === 4 && !r.problems.some((p) => /couldn't be read/.test(p)), show(r.problems));

  step("4. The list says which follow HRMS");
  const page = await listDepartments(String(ORG), { page: 1, pageSize: 50, q: "" } as any);
  const row = (n: string) => page.data.find((d) => d.name === n);
  check("Sales follows HRMS's Sales; Made by hand follows nothing", (row("Sales")?.hrmsNames ?? []).join() === "Sales" && !row("Made by hand")?.hrmsNames, show(page.data));
  check("Operations shows both it is fed by", (row("Operations")?.hrmsNames ?? []).sort().join() === "Operations Team,Ops", show(row("Operations")));
} finally {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
