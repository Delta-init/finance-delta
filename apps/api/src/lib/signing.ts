import crypto from "node:crypto";

/**
 * The canonical string both sides of the HRMS integration sign.
 *
 * Deliberately free of any config import so it can be tested on its own — the
 * failure this guards against is the two repos disagreeing by one character
 * about what gets signed, which surfaces only as a blanket 401 with no clue as
 * to why. Its counterpart is `buildCanonical` in the HRMS repo's
 * `hrms-backend/src/utils/signing.ts`; change one and you must change both.
 *
 *   METHOD \n PATH_WITH_QUERY \n TIMESTAMP \n NONCE \n sha256(body)
 */
export function buildCanonical(
  method: string,
  url: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
): string {
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  return [method.toUpperCase(), url, timestamp, nonce, bodyHash].join("\n");
}

export function signRequest(
  secret: string,
  method: string,
  url: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(buildCanonical(method, url, timestamp, nonce, rawBody))
    .digest("hex");
}
