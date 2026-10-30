/**
 * Switch off in finance everybody HRMS says has left — resigned or terminated — who is still active here (the user,
 * 2026-10-30: "remove the resigned employees from the finance now"). Until e1a08cc only "terminated" counted as
 * leaving, so people who resigned stayed active, and payable, after every sync.
 *
 * Asks HRMS live, through the same comparison as Payroll → Mapping's preview, and touches nothing else a sync would:
 * only the status (and the HRMS status kept beside it). Nobody is deleted — their payroll and payments stay on record;
 * a payroll run already imported keeps its lines (that is HRMS's batch: Recall it there).
 *
 *   bun src/scripts/deactivate-leavers.ts                 # dry run: lists them, every organization linked to HRMS
 *   bun src/scripts/deactivate-leavers.ts --write         # switches them off
 *   bun src/scripts/deactivate-leavers.ts --org <id> ...  # one finance organization only
 *   bun src/scripts/deactivate-leavers.ts --undo backups/deactivate-leavers-<time>.json
 *
 * --write saves who it changed to backups/deactivate-leavers-<time>.json; --undo with that file switches them back on.
 * Run it from apps/api on the server: Bun reads MONGODB_URI and the HRMS_* settings from the .env there.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import mongoose, { Types } from "mongoose";
import { Organization } from "../modules/organization/organization.model";
import { Employee } from "../modules/employee/employee.model";
import { PayrollOrgLink } from "../modules/payroll-mapping/org-link.model";
import { previewSync, hasLeftHrms } from "../modules/payroll-mapping/mapping.service";

export interface Leaver {
  employeeId: string;
  organizationId: string;
  hrmsOrgId: string;
  hrmsEmployeeId: string;
  employeeCode: string;
  name: string;
  hrmsStatus: string;
}

/** Everybody HRMS says has left who is still active in this finance organization, per linked HRMS organisation. */
export async function activeLeavers(orgId: string): Promise<{ hrmsOrgName: string; leavers: Leaver[] }[]> {
  const links = await PayrollOrgLink.find({ organizationId: new Types.ObjectId(orgId) })
    .lean<{ hrmsOrgId: string; hrmsOrgName?: string }[]>();
  const out = [];
  for (const link of links) {
    const preview = await previewSync(orgId, link.hrmsOrgId);
    const leavers = preview.employees
      .filter((e) => e.state === "linked" && e.employeeId && hasLeftHrms(e.hrmsStatus)
        && e.changes.some((c) => c.field === "status" && c.to === "inactive"))
      .map((e) => ({
        employeeId: e.employeeId!, organizationId: orgId, hrmsOrgId: link.hrmsOrgId, hrmsEmployeeId: e.hrmsEmployeeId,
        employeeCode: e.employeeCode, name: e.name, hrmsStatus: e.hrmsStatus,
      }));
    out.push({ hrmsOrgName: link.hrmsOrgName ?? link.hrmsOrgId, leavers });
  }
  return out;
}

/** Switch them off: status inactive, the HRMS status beside it. Only rows still active, so a second run changes nothing. */
export async function deactivate(leavers: Leaver[]): Promise<number> {
  let changed = 0;
  for (const l of leavers) {
    const res = await Employee.updateOne(
      { _id: new Types.ObjectId(l.employeeId), organizationId: new Types.ObjectId(l.organizationId), status: "active" },
      { $set: { status: "inactive", hrmsStatus: l.hrmsStatus, lastSyncedAt: new Date() } },
    );
    changed += res.modifiedCount;
  }
  return changed;
}

/** Put back the ones a --write switched off (only those still inactive). */
export async function undo(leavers: Leaver[]): Promise<number> {
  let changed = 0;
  for (const l of leavers) {
    const res = await Employee.updateOne(
      { _id: new Types.ObjectId(l.employeeId), organizationId: new Types.ObjectId(l.organizationId), status: "inactive" },
      { $set: { status: "active" } },
    );
    changed += res.modifiedCount;
  }
  return changed;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const after = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const { connectDb } = await import("../config/db");

  const undoFile = after("--undo");
  if (argv.includes("--undo")) {
    if (!undoFile) { console.error("--undo <file written by --write>"); process.exit(1); }
    const leavers = JSON.parse(readFileSync(undoFile, "utf8")) as Leaver[];
    await connectDb();
    console.log(`Switched back on: ${await undo(leavers)} of ${leavers.length}.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const only = after("--org");
  if (argv.includes("--org") && (!only || !Types.ObjectId.isValid(only))) {
    console.error("--org <finance organization id>");
    process.exit(1);
  }
  const write = argv.includes("--write");
  await connectDb();
  // Every finance organization linked to an HRMS organisation, unless one is named.
  const orgIds = only ? [only] : (await PayrollOrgLink.distinct("organizationId")).map(String);
  if (!orgIds.length) console.log("No finance organization is linked to HRMS (Payroll → Mapping).");

  const all: Leaver[] = [];
  for (const orgId of orgIds) {
    const org = await Organization.findById(orgId).select("name").lean<{ name: string } | null>();
    if (!org) { console.error(`No organization ${orgId}`); continue; }
    const groups = await activeLeavers(orgId);
    if (!groups.length) console.log(`${org.name} has no HRMS organisation linked (Payroll → Mapping).`);
    for (const g of groups) {
      console.log(`\n== ${org.name} ← HRMS ${g.hrmsOrgName}: ${g.leavers.length} left in HRMS but still active here`);
      for (const l of g.leavers) console.log(`    ${(l.employeeCode || "—").padEnd(8)} ${l.name.slice(0, 40).padEnd(40)} ${l.hrmsStatus}`);
      all.push(...g.leavers);
    }
  }

  if (!write) {
    console.log(`\nDry run — nothing was written. Add --write to switch these ${all.length} off.`);
  } else if (all.length) {
    mkdirSync("backups", { recursive: true });
    const file = `backups/deactivate-leavers-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify(all, null, 2));
    console.log(`\nSwitched off: ${await deactivate(all)} of ${all.length}. Undo: bun src/scripts/deactivate-leavers.ts --undo ${file}`);
  } else {
    console.log("\nNobody to switch off.");
  }
  await mongoose.disconnect();
}
