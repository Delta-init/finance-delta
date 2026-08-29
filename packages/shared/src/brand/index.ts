/**
 * The Delta mark, and how each surface should resolve a logo.
 *
 * One place, because the rule is the same everywhere and the consequence of
 * two places disagreeing is an invoice with one logo and its emailed copy
 * carrying another.
 *
 * The rule: an organization's own logo wins where it has set one, and Delta's
 * is used where it has not. A client organization branding its own invoices is
 * the point of that field, so this is a fallback and never a replacement.
 */

/** Served from the web app. Fine for anything rendered in a browser. */
export const DELTA_LOGO_WEB = "/delta-wordmark.webp";

/**
 * Served from object storage at an absolute URL.
 *
 * Email needs one: a mail client has no idea what host a relative path belongs
 * to, and cannot reach a file on the server's disk. It is also a PNG rather
 * than the webp used on the web, because Outlook renders no webp at all.
 */
export const DELTA_LOGO_EMAIL =
  "https://pub-8f8e5004f2ce4792b759204766030a39.r2.dev/brand/delta-wordmark.png";

/** Navy, from the wordmark itself. The teal is the gradient in the `d`. */
export const DELTA_NAVY = "#0a2c4e";
export const DELTA_TEAL = "#2ed3c6";

/**
 * Which logo a document should carry.
 *
 * `forEmail` matters: the same call inside a printed page wants the web asset
 * and inside a message wants the absolute one, and getting it the wrong way
 * round produces either a broken image in somebody's inbox or a needless
 * round trip to object storage on every page render.
 */
export function logoFor(
  branding: { logoUrl?: string | null } | null | undefined,
  opts: { forEmail?: boolean } = {},
): string {
  const own = branding?.logoUrl?.trim();
  if (own) return own;
  return opts.forEmail ? DELTA_LOGO_EMAIL : DELTA_LOGO_WEB;
}

/**
 * True when the logo shown is Delta's rather than the organization's own.
 *
 * Lets a screen that is about branding — the settings page — say "this is the
 * default" instead of showing a logo the reader thinks they uploaded.
 */
export function isFallbackLogo(branding: { logoUrl?: string | null } | null | undefined): boolean {
  return !branding?.logoUrl?.trim();
}
