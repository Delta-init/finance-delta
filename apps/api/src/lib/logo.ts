import { DELTA_LOGO_EMAIL } from "@delta/shared";

/**
 * Logos, for the documents drawn as PDFs.
 *
 * A PDF is drawn from data, not from a link, so the logo has to be fetched and
 * handed to the drawing. Fetched here rather than in the browser: a browser
 * cannot read an image from another host into a canvas unless that host says
 * it may, and the storage the logos live on need not say so.
 *
 * PNG and JPEG only — what jsPDF draws — told apart by their first bytes, never
 * by what the file was called or which type the uploader claimed.
 */

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** Delta's own, for a document whose organization has none. */
export const DEFAULT_LOGO_URL = DELTA_LOGO_EMAIL;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function logoKind(bytes: Uint8Array): "png" | "jpeg" | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/**
 * The first of these addresses that answers with a PNG or JPEG of a sensible
 * size, as a data URL — or null when none does, and the document is drawn
 * with the name alone, as it always was.
 */
export async function logoDataUrl(urls: (string | null | undefined)[]): Promise<string | null> {
  const tried = new Set<string>();
  for (const raw of urls) {
    const url = (raw ?? "").trim();
    if (!/^https?:\/\//i.test(url) || tried.has(url)) continue;
    tried.add(url);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "follow" });
      if (!res.ok) continue;
      if (Number(res.headers.get("content-length") ?? 0) > LOGO_MAX_BYTES) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > LOGO_MAX_BYTES) continue;
      const kind = logoKind(bytes);
      if (!kind) continue;
      return `data:image/${kind};base64,${Buffer.from(bytes).toString("base64")}`;
    } catch {
      // Unreachable, slow or refused: the next address, and in the end none.
    }
  }
  return null;
}
