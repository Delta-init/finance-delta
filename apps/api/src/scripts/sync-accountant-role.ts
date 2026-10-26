/**
 * Give every organization's Accountant role the accounts pages it was missing (the user, 2026-10-26: "the accounts
 * role should have every accounts page, to read, write and update — procurement, banking and many more are missing").
 *
 * `seed-system-roles` only adds a role that is missing, so an existing Accountant role stays as it was seeded. This
 * adds what the code's Accountant role has and the stored one does not — banking, expenses (with procurement,
 * advances and one-time payments), bills, vendors, purchase orders, inventory, commissions, loans, payroll — and
 * never takes anything away: whatever an administrator gave on top stays.
 *
 * Reads and prints only, unless --write. Run it from apps/api:
 *
 *   bun --env-file=<finance .env> src/scripts/sync-accountant-role.ts
 *   … --write --expect N --backups <folder>       N: how many roles get permissions added
 *   bun --env-file=<finance .env> src/scripts/sync-accountant-role.ts --undo <backup.json> [--write]
 */
import fs from "node:fs";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";

export interface PlannedRole { roleId: string; orgId: string; org: string; holders: number; adding: string[] }

/** What each organization's Accountant role is missing. Reads only. */
export async function planAccountantSync(): Promise<PlannedRole[]> {
  const wanted = SYSTEM_ROLES.find((r) => r.key === "accountant")!.permissions;
  const roles = await Role.find({ key: "accountant" }).lean<any[]>();
  const plan: PlannedRole[] = [];
  for (const role of roles) {
    const org = await mongoose.connection.db!.collection("organizations").findOne({ _id: role.organizationId }, { projection: { name: 1 } });
    const has = new Set<string>((role.permissions ?? []) as string[]);
    plan.push({
      roleId: String(role._id), orgId: String(role.organizationId), org: String(org?.name ?? role.organizationId),
      holders: await User.countDocuments({ "memberships.roleId": role._id }),
      adding: wanted.filter((p) => !has.has(p)),
    });
  }
  return plan;
}

/** Adds them, keeping a backup (written before each change) that --undo takes back out. */
export async function runAccountantSync(backupDir = "backups"): Promise<{ changed: PlannedRole[]; file: string }> {
  const todo = (await planAccountantSync()).filter((p) => p.adding.length);
  const dir = path.resolve(backupDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sync-accountant-role-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const changed: PlannedRole[] = [];
  for (const p of todo) {
    changed.push(p);
    fs.writeFileSync(file, JSON.stringify({ changed }, null, 1));
    await Role.updateOne({ _id: new Types.ObjectId(p.roleId) }, { $addToSet: { permissions: { $each: p.adding } } });
  }
  fs.writeFileSync(file, JSON.stringify({ changed }, null, 1));
  return { changed, file };
}

/** Takes out exactly what a run added — nothing an administrator gave before or since. */
export async function undoAccountantSync(file: string, write: boolean): Promise<string[]> {
  const { changed } = JSON.parse(fs.readFileSync(file, "utf8")) as { changed: PlannedRole[] };
  const out: string[] = [];
  for (const c of changed) {
    if (write) await Role.updateOne({ _id: new Types.ObjectId(c.roleId) }, { $pullAll: { permissions: c.adding } });
    out.push(`${c.org}: ${write ? "took back" : "would take back"} ${c.adding.length} permission(s)`);
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const write = argv.includes("--write");
  const { connectDb } = await import("../config/db");
  await connectDb();
  const undo = arg("--undo");
  if (undo) {
    for (const l of await undoAccountantSync(undo, write)) console.log(l);
    if (!write) console.log("\nNothing changed — run again with --write.");
    await mongoose.disconnect();
    process.exit(0);
  }
  const plan = await planAccountantSync();
  if (!plan.length) console.log("No Accountant role anywhere — run seed-system-roles first.");
  for (const p of plan) {
    console.log(`\n${p.org} — Accountant role, ${p.holders} ${p.holders === 1 ? "person" : "people"}`);
    console.log(p.adding.length ? `  adds ${p.adding.length}: ${p.adding.join(", ")}` : "  already has every accounts page");
  }
  const todo = plan.filter((p) => p.adding.length);
  console.log(`\n${todo.length} role(s) to update, ${plan.length - todo.length} already current.`);
  if (!todo.length) console.log("Nothing to change.");
  else if (!write) console.log(`Nothing changed — run again with --write --expect ${todo.length}.`);
  else if (Number(arg("--expect")) !== todo.length) {
    console.error(`Refusing: ${todo.length} role(s) to update, and --expect ${arg("--expect") ?? "(missing)"} was given.`);
    await mongoose.disconnect();
    process.exit(1);
  } else {
    const { changed, file } = await runAccountantSync(arg("--backups"));
    console.log(`\n${changed.length} Accountant role(s) updated. Backup: ${file}\nUndo: bun --env-file=<finance .env> src/scripts/sync-accountant-role.ts --undo ${file} --write`);
    console.log("Accountants may need to sign in again to see the new pages.");
  }
  await mongoose.disconnect();
}
