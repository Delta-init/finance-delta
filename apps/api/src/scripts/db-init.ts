/**
 * Initializes the local MongoDB single-node replica set (required for the
 * transactions the posting engine will use in later phases). Safe to re-run.
 * Run after `docker compose up -d`, via `bun run db:init`.
 */
import mongoose from "mongoose";
import { logger } from "../lib/logger";

async function init() {
  const conn = await mongoose.connect("mongodb://localhost:27017/admin", {
    directConnection: true,
  });
  const admin = conn.connection.db!.admin();
  try {
    await admin.command({ replSetGetStatus: 1 });
    logger.info("Replica set already initialized");
  } catch {
    await admin.command({
      replSetInitiate: {
        _id: "rs0",
        members: [{ _id: 0, host: "localhost:27017" }],
      },
    });
    logger.info("✅ Replica set rs0 initiated");
  }
  await mongoose.disconnect();
}

init().catch((err) => {
  logger.error({ err }, "db:init failed");
  process.exit(1);
});
