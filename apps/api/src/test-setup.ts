/**
 * Environment for the test run, established before any module loads.
 *
 * `config/env.ts` validates on import and exits the process on failure, so a
 * test that pulls in anything reaching it dies at import time unless these are
 * already set. Doing it in a `beforeAll` only ever works by accident — it
 * depends which test file bun happens to load first, and adding an unrelated
 * test moves that around.
 *
 * MONGODB_URI deliberately points at a local, obviously-fake database. Nothing
 * here connects, but the real .env points at a live server, and a suite that
 * could reach it by loading dotenv is one bad import away from writing to it.
 *
 * `??=` throughout, so a value the caller actually set is never overridden.
 */
const defaults: Record<string, string> = {
  NODE_ENV: "test",
  MONGODB_URI: "mongodb://127.0.0.1:27017/finance-test-never-connected",
  JWT_ACCESS_SECRET: "test-access-secret-long-enough-to-pass",
  JWT_REFRESH_SECRET: "test-refresh-secret-long-enough-to-pass",
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
