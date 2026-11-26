/**
 * LMS hand-overs given up on, sent again (2026-11-26) — retry-lms-provisions.ts on a scratch database, and the
 * worker's new rule: a course the LMS doesn't know is retried for two days before it stops; other refusals stop at
 * once, outages never do. Run through scripts/retry-lms-provisions-e2e.sh.
 */
import mongoose, { Types } from "mongoose";
import { existsSync, unlinkSync } from "node:fs";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) { console.error(`Refusing: ${uri}`); process.exit(1); }
let failures = 0, checks = 0;
const check = (label: string, ok: boolean, detail = "") => { checks++; if (ok) console.log(`  ✓ ${label}`); else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); } };
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 400);

await mongoose.connect(uri);
await mongoose.connection.db!.dropDatabase();
const db = mongoose.connection.db!;
const { retryProvisions, undoRetry } = await import("./retry-lms-provisions");
const { stopsForGood } = await import("../jobs/lms-provision.worker");
const { LmsPermanentError } = await import("../lib/lms-client");

const row = (n: string, status: string, lastError: string) => ({ _id: new Types.ObjectId(), organizationId: new Types.ObjectId(), invoiceId: new Types.ObjectId(), invoiceNumber: n, status, attempts: 1, lastError, payload: { courseSlug: "market-break-out-trading-program" }, nextAttemptAt: new Date(), createdAt: new Date("2026-11-24T12:00:00Z") });
const missing = 'No course with slug "market-break-out-trading-program"';
await db.collection("lmsprovisions").insertMany([
  row("IN-00527", "failed", missing), row("IN-00530", "failed", missing), row("IN-00060", "failed", missing),
  row("IN-00400", "failed", "Invalid email"), row("IN-00401", "sent", ""), row("IN-00402", "pending", ""),
]);
const st = async (n: string) => (await db.collection("lmsprovisions").findOne({ invoiceNumber: n })) as any;

const dry = await retryProvisions({ match: "No course with slug", write: false });
check("read only: the 3 with the missing course listed, nothing changed", dry.lines.at(-1) === '3 failed with "No course with slug"' && (await st("IN-00527")).status === "failed", j(dry.lines));
let refused = "";
try { await retryProvisions({ match: "No course with slug", write: true, expect: 13 }); } catch (e) { refused = (e as Error).message; }
check("--expect that doesn't match: refused, nothing changed", /Expected 13, found 3/.test(refused) && (await st("IN-00527")).status === "failed", refused);
const undoFile = `${process.env.TMPDIR ?? "/tmp"}/retry-lms-e2e-${Date.now()}.json`;
const w = await retryProvisions({ match: "No course with slug", write: true, expect: 3, undoFile });
const a = await st("IN-00527");
check("--write: the 3 back in the queue, tried now, attempts 0, the error cleared", a.status === "pending" && a.attempts === 0 && !a.lastError && new Date(a.nextAttemptAt).getTime() <= Date.now() && (await st("IN-00060")).status === "pending", j(a));
check("others untouched: another error stays failed, sent stays sent", (await st("IN-00400")).status === "failed" && (await st("IN-00401")).status === "sent", j(w.lines));
check("the undo file was written first", existsSync(undoFile));
await db.collection("lmsprovisions").updateOne({ invoiceNumber: "IN-00530" }, { $set: { status: "sent" } });
const u = await undoRetry(undoFile);
check("undo: still waiting → failed again as it was; one sent since → left", (await st("IN-00527")).status === "failed" && (await st("IN-00527")).lastError === missing && (await st("IN-00530")).status === "sent", j(u));
unlinkSync(undoFile);

const t0 = new Date("2026-11-24T12:00:00Z").getTime();
check("worker: a missing course a day old is tried again", stopsForGood(new LmsPermanentError(missing), new Date(t0), t0 + 24 * 3600_000) === false);
check("worker: a missing course two days on stops", stopsForGood(new LmsPermanentError(missing), new Date(t0), t0 + 49 * 3600_000) === true);
check("worker: another refusal stops at once", stopsForGood(new LmsPermanentError("Invalid email"), new Date(t0), t0 + 60_000) === true);
check("worker: an outage never stops", stopsForGood(new Error("ECONNREFUSED"), new Date(t0), t0 + 30 * 24 * 3600_000) === false);

console.log(`\n${checks - failures}/${checks} checks passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
