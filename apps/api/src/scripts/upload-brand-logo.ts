/**
 * Put the email logo in object storage.
 *
 * Email is the one surface that cannot use the asset in `apps/web/public`: a
 * mail client has no idea what host a relative path belongs to, so the logo
 * has to live somewhere with an absolute URL. This uploads it and prints that
 * URL, which is the one hard-coded in `packages/shared/src/brand`.
 *
 * The key is fixed rather than timestamped, so re-running replaces the file
 * and every message already sent goes on rendering. Run it after changing the
 * logo; nothing else needs to know.
 *
 * Run with:  bun apps/api/src/scripts/upload-brand-logo.ts
 */

import { DELTA_LOGO_EMAIL } from "@delta/shared";
import { uploadFile, storageConfigured } from "../lib/storage";

const KEY = "brand/delta-wordmark.png";
const SOURCE = new URL("../../../web/public/delta-wordmark-email.png", import.meta.url).pathname;

async function run() {
  if (!storageConfigured()) {
    console.error("Storage is not configured — set the R2 variables first.");
    process.exit(1);
  }

  const file = Bun.file(SOURCE);
  if (!(await file.exists())) {
    console.error(`Not found: ${SOURCE}`);
    process.exit(1);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const res = await uploadFile({
    key: KEY,
    buffer,
    mimeType: "image/png",
    originalName: "delta-wordmark.png",
  });

  console.log(`Uploaded ${(res.size / 1024).toFixed(0)} KB to ${res.url}`);

  // Said plainly, because the URL is compiled into the shared brand module and
  // a bucket whose public host differs would leave every email with a broken
  // image and nothing to explain why.
  if (res.url !== DELTA_LOGO_EMAIL) {
    console.warn(
      `\nWARNING: that is not the URL emails use.\n` +
        `  emails point at: ${DELTA_LOGO_EMAIL}\n` +
        `  this uploaded to: ${res.url}\n` +
        `Update DELTA_LOGO_EMAIL in packages/shared/src/brand/index.ts to match.`,
    );
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
