/**
 * Who in HRMS is missing in finance (the user, 2026-10-22: "why Vandana and others are not here … which employees
 * are missing in finance from the HRMS") — READ ONLY: nothing is written anywhere.
 *
 * For each HRMS organisation linked to the finance organization, the same comparison as Payroll → Mapping's preview:
 *
 *   - not in finance at all — HRMS has them, finance has no record (hired since the last sync, or never synced);
 *   - in finance as an employee but with no finance account — they cannot be picked as a salesperson;
 *   - matched to an existing finance account, not linked yet;
 *   - blocked — and why (no email in HRMS, an email another account already has, …);
 *   - in finance but no longer in HRMS.
 *
 * People who have left (terminated / resigned) are counted, not listed, unless --all. Bringing them over is
 * Payroll → Mapping → Sync in finance.
 *
 *   bun src/scripts/hrms-missing-employees.ts --org <finance organization id> [--all]
 *
 * Run it from apps/api on the server: Bun reads MONGODB_URI and the HRMS_* settings from the .env there.
 */
import mongoose, { Types } from "mongoose";
import { Organization } from "../modules/organization/organization.model";
import { PayrollOrgLink } from "../modules/payroll-mapping/org-link.model";
import { previewSync, type EmpRow } from "../modules/payroll-mapping/mapping.service";

const LEFT = new Set(["terminated", "resigned", "inactive"]);

export interface MissingReport {
  hrmsOrgName: string;
  notInFinance: EmpRow[];
  noAccount: EmpRow[];
  toLink: EmpRow[];
  blocked: EmpRow[];
  goneFromHrms: EmpRow[];
  leftCount: number;
}

/** The comparison for every HRMS organisation linked to this finance organization. */
export async function missingEmployees(orgId: string, includeLeft = false): Promise<MissingReport[]> {
  const links = await PayrollOrgLink.find({ organizationId: new Types.ObjectId(orgId) }).lean<{ hrmsOrgId: string }[]>();
  const out: MissingReport[] = [];
  for (const link of links) {
    const p = await previewSync(orgId, link.hrmsOrgId);
    const here = (e: EmpRow) => includeLeft || !LEFT.has(String(e.hrmsStatus).toLowerCase());
    out.push({
      hrmsOrgName: p.hrmsOrgName ?? link.hrmsOrgId,
      notInFinance: p.employees.filter((e) => e.state === "new" && here(e)),
      noAccount: p.employees.filter((e) => e.state === "linked" && !e.userId && here(e)),
      toLink: p.employees.filter((e) => e.state === "proposed" && here(e)),
      blocked: p.employees.filter((e) => e.state === "conflict" && here(e)),
      goneFromHrms: p.employees.filter((e) => e.state === "orphaned"),
      leftCount: includeLeft ? 0 : p.employees.filter((e) => e.state !== "orphaned" && e.state !== "linked" && LEFT.has(String(e.hrmsStatus).toLowerCase())).length,
    });
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const orgId = argv[argv.indexOf("--org") + 1];
  if (!argv.includes("--org") || !orgId || !Types.ObjectId.isValid(orgId)) {
    console.error("--org <finance organization id> is required");
    process.exit(1);
  }
  const { connectDb } = await import("../config/db");
  await connectDb();
  const org = await Organization.findById(orgId).select("name").lean<{ name: string } | null>();
  if (!org) { console.error(`No organization ${orgId}`); process.exit(1); }
  const reports = await missingEmployees(orgId, argv.includes("--all"));
  if (!reports.length) console.log(`${org.name} has no HRMS organisation linked (Payroll → Mapping).`);
  const line = (e: EmpRow, extra = "") =>
    `    ${(e.employeeCode || "—").padEnd(8)} ${e.name.slice(0, 30).padEnd(30)} ${(e.email || "no email").slice(0, 36).padEnd(36)} ${String(e.hrmsStatus).padEnd(10)}${extra}`;
  for (const r of reports) {
    console.log(`\n== ${org.name} ← HRMS ${r.hrmsOrgName}`);
    const section = (title: string, rows: EmpRow[], why = false) => {
      console.log(`\n  ${title}: ${rows.length}`);
      for (const e of rows) console.log(line(e, why ? `  ${e.issues.join("; ")}` : ""));
    };
    section("Not in finance at all (sync would add them)", r.notInFinance);
    section("In finance, but with no finance account — cannot be picked as a salesperson", r.noAccount);
    section("Matches an existing finance account, not linked yet (sync would link them)", r.toLink);
    section("Blocked — and why", r.blocked, true);
    section("In finance, no longer in HRMS", r.goneFromHrms);
    if (r.leftCount) console.log(`\n  (${r.leftCount} who have left HRMS not listed — add --all to see them)`);
  }
  console.log("\nRead only — nothing was written. To bring them over: finance → Payroll → Mapping → Sync.");
  await mongoose.disconnect();
}
