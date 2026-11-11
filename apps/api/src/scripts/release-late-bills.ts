/**
 * Lets go of bills and bill payments still waiting for a manager because of an old date — bills no longer ask (the
 * user, 2026-11-11: "removal approval things in Late Bills ( date of bill in past )"). Each one's own late entry is
 * cleared, the request withdrawn (off the managers' Waiting list), and a released payment put in its account.
 *
 * Reads only unless --write is given: it lists what would be released.
 *
 *   cd apps/api && bun src/scripts/release-late-bills.ts            # look
 *   cd apps/api && bun src/scripts/release-late-bills.ts --write    # release them
 *
 * Uses MONGODB_URI from the environment (the API's .env) — run it where the finance API runs, after the API deploy.
 */
import mongoose from "mongoose";
import { releaseWaitingBills } from "../modules/bill/release-late";

const uri = process.env.MONGODB_URI ?? "";
if (!uri) {
  console.error("Set MONGODB_URI (the finance API's database).");
  process.exit(1);
}
const write = process.argv.includes("--write");
await mongoose.connect(uri);
const orgs = new Map((await mongoose.connection.db!.collection("organizations").find({}, { projection: { name: 1 } }).toArray()).map((o) => [String(o._id), String(o.name)]));
const rows = await releaseWaitingBills(write);
const money = (m: number, c: string) => `${c} ${(m / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
for (const r of rows) console.log(`${write ? "released" : "would release"} · ${orgs.get(r.orgId) ?? r.orgId} · ${r.billNumber} · ${r.vendorName} · ${r.what} · ${money(r.amountMinor, r.currency)}`);
console.log(rows.length ? `\n${rows.length} ${write ? "released" : "waiting — run again with --write to release them"}.` : "Nothing waiting.");
await mongoose.disconnect();
