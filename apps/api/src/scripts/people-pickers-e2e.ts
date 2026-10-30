/**
 * The salesperson pickers take in everybody, and who in HRMS is missing in finance (the user, 2026-10-22: "why are
 * Vandana and others not here … which employees are missing in finance from the HRMS") — finance's services, with a
 * stand-in HRMS answering like the real one's directory.
 *
 * What it proves:
 *   - the users list takes up to 1,000 a page: with 130 people, a picker gets all of them — at the old 100 the ones
 *     past the hundredth name (Vandana) were never in it; past 1,000 is refused;
 *   - scripts/hrms-missing-employees.ts says, per linked HRMS organisation: not in finance at all, in finance with no
 *     account (so not a salesperson), matching a finance account not linked yet, blocked and why, gone from HRMS;
 *     people who have left are counted, not listed, unless asked;
 *   - the mapping (previewSync) takes a resignation as leaving, as it does a termination (2026-10-30): somebody who
 *     resigned in HRMS and is still active here is offered deactivation, one already inactive needs nothing;
 *   - scripts/deactivate-leavers.ts lists exactly those, switches them off (--write) and back on (--undo).
 *
 * Run through scripts/people-pickers-e2e.sh (throwaway mongod, stand-in HRMS, no .env anywhere).
 */
import http from "node:http";
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const PORT = Number(new URL(process.env.HRMS_API_URL ?? "http://127.0.0.1:0").port);

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Role } = await import("../modules/role/role.model");
const { Employee } = await import("../modules/employee/employee.model");
const { PayrollOrgLink } = await import("../modules/payroll-mapping/org-link.model");
const users = await import("../modules/user/user.service");
const { missingEmployees } = await import("./hrms-missing-employees");
const { userQuerySchema } = await import("@delta/shared");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 500);

/* ── A stand-in HRMS directory ── */
const H1 = new Types.ObjectId().toString();
const emp = (id: string, name: string, email: string, status = "active") => ({
  id, organizationId: H1, employeeCode: id, name, email, departmentId: null, designation: "Sales", employmentType: "full_time",
  status, joiningDate: null, currency: "AED", hasBankDetails: true, updatedAt: "2026-10-01T00:00:00.000Z",
});
const ROSTER = [
  emp("E1", "Farhan", "farhan@x.test"),            // in finance, with an account
  emp("E2", "Nisha", "nisha@x.test"),              // in finance, no account
  emp("E3", "Vandana", "vandana@x.test"),          // not in finance
  emp("E4", "Rahul", ""),                          // not in finance, no email
  emp("E5", "Old Hand", "old@x.test", "terminated"), // left
  emp("E6", "Sara", "sara@x.test"),                // a finance account of that email, not linked
  emp("E7", "Twin A", "twin@x.test"),              // two share an email: blocked
  emp("E8", "Twin B", "twin@x.test"),
];
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname.endsWith("/directory/departments")) return send(200, { success: true, data: [] });
  if (url.pathname.endsWith("/directory/employees")) return send(200, { success: true, data: ROSTER, pagination: { page: 1, totalPages: 1 } });
  send(404, { success: false, message: "Route not found" });
});
await new Promise<void>((ok) => server.listen(PORT, "127.0.0.1", ok));

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const ORG = String(org._id);
const role = await Role.create({ organizationId: org._id, key: "sales", name: "Sales", permissions: [] });
const person = (name: string, email: string) => User.create({ name, email, passwordHash: "x", status: "active",
  memberships: [{ organizationId: org._id, roleId: role._id, status: "active" }] });

/* ── 1 ── */
step("1. The pickers take in everybody");
for (let i = 1; i <= 128; i++) await person(`Aaron ${String(i).padStart(3, "0")}`, `aaron${i}@x.test`);
const farhan = await person("Farhan", "farhan@x.test");
await person("Vandana K", "vandana.k@x.test");
await person("Sara", "sara@x.test");
const at = (pageSize: number) => users.listUsers(ORG, userQuerySchema.parse({ page: 1, pageSize, sort: "name", dir: "asc" }) as never);
const old = await at(100), now = await at(1000);
check("at the old 100 a name past the hundredth was never in the picker", old.data.length === 100 && !old.data.some((u) => u.name === "Vandana K"));
check("at 1,000: all 131, Vandana among them", now.data.length === 131 && now.data.some((u) => u.name === "Vandana K"), String(now.data.length));
check("more than 1,000 a page: refused", !userQuerySchema.safeParse({ pageSize: 1001 }).success && userQuerySchema.safeParse({ pageSize: 1000 }).success);

/* ── 2 ── */
step("2. Who in HRMS is missing in finance");
await PayrollOrgLink.create({ organizationId: org._id, hrmsOrgId: H1, hrmsOrgName: "Delta HRMS E2E", linkedByUserId: farhan._id, linkedByName: "Farhan" });
const empRec = (id: string, name: string, userId: Types.ObjectId | null) => Employee.create({ organizationId: org._id, hrmsOrgId: H1, hrmsEmployeeId: id,
  employeeCode: id, name, email: `${name.toLowerCase()}@x.test`, userId, status: "active" });
await empRec("E1", "Farhan", farhan._id);
await empRec("E2", "Nisha", null);
await empRec("E9", "Gone", null);                 // HRMS no longer has them
const [r] = await missingEmployees(ORG);
const names = (rows: { name: string }[] = []) => rows.map((e) => e.name).sort();
check("not in finance at all: Vandana, and Rahul (no email)", j(names(r?.notInFinance)) === j(["Rahul", "Vandana"]), j(names(r?.notInFinance)));
check("…Rahul's reason said: no email in HRMS", r?.notInFinance.find((e) => e.name === "Rahul")?.issues.some((i) => /No email in HRMS/.test(i)) === true);
check("in finance with no account (not a salesperson): Nisha", j(names(r?.noAccount)) === j(["Nisha"]), j(names(r?.noAccount)));
check("matching a finance account, not linked yet: Sara", j(names(r?.toLink)) === j(["Sara"]), j(names(r?.toLink)));
check("blocked, and why: the two sharing an email", j(names(r?.blocked)) === j(["Twin A", "Twin B"]) && r!.blocked.every((e) => e.issues.some((i) => /share this email/.test(i))), j(r?.blocked));
check("in finance, gone from HRMS: Gone", j(names(r?.goneFromHrms)) === j(["Gone"]));
check("the one who left: counted, not listed", r?.leftCount === 1 && !r.notInFinance.some((e) => e.name === "Old Hand"), j(r?.leftCount));
const [all] = await missingEmployees(ORG, true);
check("--all lists them too", all!.notInFinance.some((e) => e.name === "Old Hand"));
check("nothing written", (await Employee.countDocuments()) === 3 && (await User.countDocuments()) === 131);

/* ── 3 ── */
step("3. Resigned is leaving too");
const { previewSync, hasLeftHrms } = await import("../modules/payroll-mapping/mapping.service");
ROSTER.push(emp("E10", "Rhea", "rhea@x.test", "resigned"), emp("E11", "Tom", "tom@x.test", "resigned"));
await Employee.create({ organizationId: org._id, hrmsOrgId: H1, hrmsEmployeeId: "E10", employeeCode: "E10", name: "Rhea", email: "rhea@x.test", status: "active" });
await Employee.create({ organizationId: org._id, hrmsOrgId: H1, hrmsEmployeeId: "E11", employeeCode: "E11", name: "Tom", email: "tom@x.test", status: "inactive" });
check("terminated and resigned have left; active has not", hasLeftHrms("terminated") && hasLeftHrms("resigned") && !hasLeftHrms("active") && !hasLeftHrms(undefined));
const preview = await previewSync(ORG, H1);
const row = (id: string) => preview.employees.find((e) => e.hrmsEmployeeId === id);
check("resigned, still active here: offered active → inactive", j(row("E10")?.changes.find((c) => c.field === "status")) === j({ field: "status", from: "active", to: "inactive" }), j(row("E10")));
check("resigned, already inactive here: no status change", !row("E11")?.changes.some((c) => c.field === "status"), j(row("E11")));
check("still employed: no status change", !row("E1")?.changes.some((c) => c.field === "status"), j(row("E1")));

/* ── 4 ── */
step("4. deactivate-leavers: switch off those who left");
const { activeLeavers, deactivate, undo } = await import("./deactivate-leavers");
const [g] = await activeLeavers(ORG);
check("lists only the resigned one still active here (Rhea), not Tom (already off) nor current staff", j(g?.leavers.map((l) => [l.name, l.hrmsStatus])) === j([["Rhea", "resigned"]]), j(g?.leavers));
const before = await Employee.countDocuments({ organizationId: org._id, status: "active" });
check("--write switches her off, and only her", (await deactivate(g!.leavers)) === 1
  && (await Employee.findOne({ hrmsEmployeeId: "E10" }).lean())?.status === "inactive"
  && (await Employee.countDocuments({ organizationId: org._id, status: "active" })) === before - 1);
check("a second run finds nobody", (await activeLeavers(ORG))[0]?.leavers.length === 0);
check("--undo puts her back", (await undo(g!.leavers)) === 1 && (await Employee.findOne({ hrmsEmployeeId: "E10" }).lean())?.status === "active");

server.close();
console.log(`\n${failures ? "\x1b[31m" : "\x1b[32m"}${checks - failures}/${checks} passed\x1b[0m`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
