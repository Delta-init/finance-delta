/**
 * scripts/sync-accountant-role.ts (the user, 2026-10-26: the Accountant role gets every accounts page) against a
 * scratch database: what each organization's Accountant role is missing, added without taking anything away, a second
 * run with nothing to do, the undo taking back only what was added — and the role then opening each accounts page.
 * Run through scripts/sync-accountant-role-e2e.sh (throwaway mongod, no .env).
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) { console.error(`Refusing: ${uri}`); process.exit(1); }
const { SYSTEM_ROLES, hasPermission } = await import("@delta/shared");
const { Role } = await import("../modules/role/role.model");
const sync = await import("./sync-accountant-role");

let failures = 0, checks = 0;
const check = (label: string, ok: boolean, detail = "") => { checks++; if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`); else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); } };
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);

await mongoose.connect(uri);
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const OLD = ["customer:read", "customer:write", "customer:create", "customer:update", "customer:delete", "quotation:read", "quotation:create", "quotation:update", "quotation:delete",
  "salesorder:read", "salesorder:create", "salesorder:update", "salesorder:delete", "tag:read", "tag:create", "tag:update", "tag:delete", "invoice:read", "invoice:write",
  "report:read", "ledger:read", "ledger:write", "organization:read", "budget:read", "budget:manage", "budget:approve", "tetra_deposit:approve"];
const hq = new Types.ObjectId(), blr = new Types.ObjectId();
await db.collection("organizations").insertMany([{ _id: hq, name: "Delta HQ" }, { _id: blr, name: "Bangalore" }]);
// HQ's is as seeded; Bangalore's has had something added by an administrator (user:read) and banking:read already.
const hqRole = await Role.create({ organizationId: hq, key: "accountant", name: "Accountant", description: "", permissions: OLD, isSystem: true });
const blrRole = await Role.create({ organizationId: blr, key: "accountant", name: "Accountant", description: "", permissions: [...OLD, "user:read", "banking:read"], isSystem: true });
await db.collection("users").insertMany([{ name: "Ammu", email: "ammu@e2e.test", memberships: [{ organizationId: hq, roleId: hqRole._id }] }, { name: "Basil", email: "basil@e2e.test", memberships: [{ organizationId: blr, roleId: blrRole._id }] }]);
const wanted = SYSTEM_ROLES.find((r) => r.key === "accountant")!.permissions;

console.log("\n\x1b[1m1. The code's Accountant role\x1b[0m");
for (const p of ["banking:read", "banking:write", "banking:reconcile", "expense:approve", "bill:approve", "po:create", "vendor:update", "inventory:adjust", "commission:approve", "loan:write", "payroll:approve", "payroll:pay"]) {
  if (!wanted.includes(p)) check(`has ${p}`, false);
}
check("every accounts page, to read, add and change", ["banking:reconcile", "expense:approve", "bill:approve", "po:update", "vendor:update", "inventory:adjust", "commission:approve", "loan:write", "payroll:pay"].every((p) => wanted.includes(p)));
check("…no deleting, and no users, roles or organization settings", !wanted.some((p) => /:delete$/.test(p) && !/^(customer|quotation|salesorder|tag):/.test(p)) && !wanted.some((p) => /^(user|role):/.test(p) || p === "organization:update"), j(wanted.filter((p) => /:delete$|^user:|^role:/.test(p))));

console.log("\n\x1b[1m2. The plan\x1b[0m");
let plan = await sync.planAccountantSync();
const of = (org: string) => plan.find((p) => p.org === org);
check("both organizations' Accountant roles, with who holds them", plan.length === 2 && of("Delta HQ")?.holders === 1 && of("Bangalore")?.holders === 1, j(plan));
check("HQ's adds everything new", of("Delta HQ")?.adding.length === wanted.length - OLD.length, j(of("Delta HQ")?.adding));
check("Bangalore's doesn't add what it already has", !of("Bangalore")?.adding.includes("banking:read") && of("Bangalore")!.adding.length === wanted.length - OLD.length - 1);
check("…nothing written yet", (await Role.findById(hqRole._id).lean<any>())?.permissions.length === OLD.length);

console.log("\n\x1b[1m3. Written\x1b[0m");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-sync-"));
const { changed, file } = await sync.runAccountantSync(dir);
const hqNow = (await Role.findById(hqRole._id).lean<any>())!.permissions as string[];
const blrNow = (await Role.findById(blrRole._id).lean<any>())!.permissions as string[];
check("two roles updated", changed.length === 2);
check("HQ's now has every permission the code's role has", wanted.every((p) => hqNow.includes(p)) && hqNow.length === wanted.length, j(hqNow.length));
check("Bangalore's too, and keeps what the administrator gave (user:read)", wanted.every((p) => blrNow.includes(p)) && blrNow.includes("user:read"));
for (const [page, perm] of [["Banking", "banking:read"], ["Reconcile", "banking:reconcile"], ["Procurement / advances / one-time payments", "expense:approve"], ["Bills", "bill:update"],
  ["Purchase orders", "po:create"], ["Vendors", "vendor:create"], ["Inventory", "inventory:adjust"], ["Commissions", "commission:approve"], ["Loans", "loan:write"], ["Payroll", "payroll:pay"]] as const) {
  check(`an accountant opens ${page}`, hasPermission(hqNow, perm as never));
}
check("…but can't delete a bill or manage users", !hasPermission(hqNow, "bill:delete" as never) && !hasPermission(hqNow, "user:create" as never));
plan = await sync.planAccountantSync();
check("a second run has nothing to do", plan.every((p) => p.adding.length === 0));

console.log("\n\x1b[1m4. Undo\x1b[0m");
const said = await sync.undoAccountantSync(file, false);
check("a dry undo changes nothing", said.length === 2 && (await Role.findById(hqRole._id).lean<any>())!.permissions.length === wanted.length);
await sync.undoAccountantSync(file, true);
const hqBack = (await Role.findById(hqRole._id).lean<any>())!.permissions as string[];
const blrBack = (await Role.findById(blrRole._id).lean<any>())!.permissions as string[];
check("undone: HQ's back to as it was", hqBack.length === OLD.length && OLD.every((p) => hqBack.includes(p)), j(hqBack.length));
check("…Bangalore's keeps banking:read and user:read, which it had before", blrBack.includes("banking:read") && blrBack.includes("user:read") && blrBack.length === OLD.length + 2, j(blrBack.length));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
