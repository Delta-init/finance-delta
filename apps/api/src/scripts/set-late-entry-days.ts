/**
 * Sets every organization's late-entry days (Settings → Late entries) — the user, 2026-10-21: "change the days to one
 * day, yesterday included". With 1, anything dated before today needs a reason and a manager.
 *
 * Reads only unless --write is given: it lists each organization with its days now and what it would become.
 *
 *   cd apps/api && bun src/scripts/set-late-entry-days.ts            # look
 *   cd apps/api && bun src/scripts/set-late-entry-days.ts --write    # set them
 *   DAYS=2 bun src/scripts/set-late-entry-days.ts --write            # another number (0 turns it off)
 *
 * Uses MONGODB_URI from the environment (the API's .env) — run it where the finance API runs.
 */
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!uri) {
  console.error("Set MONGODB_URI (the finance API's database).");
  process.exit(1);
}
const DAYS = Number(process.env.DAYS ?? "1");
if (!Number.isInteger(DAYS) || DAYS < 0 || DAYS > 365) {
  console.error(`DAYS must be a whole number from 0 to 365, got "${process.env.DAYS}".`);
  process.exit(1);
}
const write = process.argv.includes("--write");

await mongoose.connect(uri);
const orgs = mongoose.connection.db!.collection("organizations");
const all = await orgs.find({}, { projection: { name: 1, lateEntryDays: 1 } }).sort({ name: 1 }).toArray();
let changing = 0;
for (const o of all) {
  const now = typeof o.lateEntryDays === "number" ? String(o.lateEntryDays) : "not set";
  const change = o.lateEntryDays !== DAYS;
  if (change) changing++;
  console.log(`${change ? "→" : "="} ${o.name}: ${now}${change ? ` → ${DAYS}` : ""}`);
}
if (!write) {
  console.log(`\n${changing} of ${all.length} would change. Nothing written — run again with --write.`);
} else {
  const r = await orgs.updateMany({ lateEntryDays: { $ne: DAYS } }, { $set: { lateEntryDays: DAYS, updatedAt: new Date() } });
  console.log(`\nSet ${r.modifiedCount} organization${r.modifiedCount === 1 ? "" : "s"} to ${DAYS} day${DAYS === 1 ? "" : "s"}.`);
}
await mongoose.disconnect();
