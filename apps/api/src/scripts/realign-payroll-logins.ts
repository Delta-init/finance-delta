/**
 * Realigns a payroll-minted login with the address HRMS holds for that person.
 *
 * `applySync` creates a finance User from the employee's HRMS email, and on
 * every later sync it refreshes the Employee row — but never the User. So when
 * somebody's address is corrected in HRMS, the mirror follows and the login
 * does not, and the two drift apart for good. Attribution is what breaks: a
 * closed lead arrives from the CRM carrying the person's real address,
 * `resolveSalesperson` looks it up, finds nothing, and the invoice lands on the
 * fallback approver with a flag on it.
 *
 * This walks the Employee rows and moves each linked login onto the address its
 * own row already carries.
 *
 * Skipped, never guessed at:
 *   - anybody who has signed in. Their address is a credential they have
 *     actually used, and moving it locks them out of the one they know.
 *   - a target address another account already holds. Email is unique across
 *     the platform, and merging two people is not a rename.
 *   - anybody named in --skip. HRMS is the authority here, but it is not the
 *     only system holding an address: where the CRM still points at the login's
 *     *current* address, moving it would break the attribution this exists to
 *     repair. That cannot be detected from inside finance, so it is passed in.
 *
 * Run with:
 *   bun --env-file=apps/api/.env apps/api/src/scripts/realign-payroll-logins.ts
 *   bun --env-file=apps/api/.env apps/api/src/scripts/realign-payroll-logins.ts --apply
 *   ... --apply --skip=E0194,E0201
 *
 * Without --apply it only reports.
 */

import mongoose from "mongoose";
import { connectDb } from "../config/db";

const APPLY = process.argv.includes("--apply");
const SKIP = new Set(
  (process.argv.find((a) => a.startsWith("--skip="))?.slice("--skip=".length) ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean),
);
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

async function run() {
  await connectDb();
  const db = mongoose.connection.db!;
  const users = db.collection("users");
  const employees = db.collection("employees");

  const rows = await employees.find({ userId: { $type: "objectId" } }).toArray();
  console.log(`${rows.length} employee rows carry a finance login\n`);

  const moved: string[] = [];
  const signedIn: string[] = [];
  const taken: string[] = [];
  const noEmail: string[] = [];
  const held: string[] = [];

  for (const emp of rows) {
    const target = norm(emp.email);
    const user = await users.findOne({ _id: emp.userId });
    if (!user) continue;
    if (!target) {
      noEmail.push(`${emp.employeeCode} ${emp.name}`);
      continue;
    }
    if (norm(user.email) === target) continue;

    const line = `${String(emp.employeeCode).padEnd(7)} ${String(emp.name).slice(0, 34).padEnd(34)} ${norm(user.email)} -> ${target}`;

    if (SKIP.has(norm(emp.employeeCode))) {
      held.push(line);
      continue;
    }
    if (user.lastLoginAt) {
      signedIn.push(`${line}   (last signed in ${new Date(user.lastLoginAt).toISOString().slice(0, 10)})`);
      continue;
    }
    const clash = await users.findOne({ email: target, _id: { $ne: user._id } });
    if (clash) {
      taken.push(`${line}   (held by ${clash.name})`);
      continue;
    }

    if (APPLY) {
      await users.updateOne({ _id: user._id }, { $set: { email: target, updatedAt: new Date() } });
    }
    moved.push(line);
  }

  const say = (title: string, list: string[]) => {
    if (!list.length) return;
    console.log(`${title} (${list.length})`);
    list.forEach((l) => console.log(`  ${l}`));
    console.log();
  };

  say(APPLY ? "Moved" : "Would move", moved);
  say("Skipped — has signed in, so the old address is a credential in use", signedIn);
  say("Skipped — target address belongs to another account", taken);
  say("Skipped — no address in HRMS to move them to", noEmail);
  say("Skipped — asked for by --skip, something else still points at the old address", held);

  console.log(
    APPLY
      ? `Done. ${moved.length} login(s) realigned, ${signedIn.length + taken.length + noEmail.length + held.length} skipped.`
      : `Dry run. ${moved.length} login(s) would move. Re-run with --apply.`,
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
