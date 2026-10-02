/**
 * Drives the logo — uploaded in settings, drawn on the invoice — and the
 * payment that is more than the balance, against a real API process.
 *
 * What it proves:
 *   - an uploaded logo must be a PNG or JPG, by its bytes, of 2 MB or less, and
 *     only somebody who may change the organization's settings uploads one; a
 *     server with no file storage says so instead of failing;
 *   - an invoice's PDF is drawn with the logo it was made under, else the
 *     organization's now, else Delta's — and the next of those whenever one is
 *     missing, not an image, or too big;
 *   - only somebody who may read the invoice gets its logo;
 *   - the PDF has the logo in it, as an image, and without one is drawn as before;
 *   - a payment over the balance is turned down in the invoice's currency,
 *     not in fils.
 *
 * Run through scripts/branding-e2e.sh (throwaway mongod + API, no .env).
 */
import http from "node:http";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES, buildInvoicePdf } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Customer } from "../modules/customer/customer.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/[^/?]*e2e/.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const BASE = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "4137"}/api/v1`;
const IMAGES = `http://127.0.0.1:${process.env.E2E_IMAGE_PORT ?? "4138"}`;
const PASSWORD = "E2ePassword1!";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail = "") {
  checks++;
  if (condition) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(name: string) { console.log(`\n\x1b[1m${name}\x1b[0m`); }
const show = (v: unknown) => JSON.stringify(v).slice(0, 300);

type Res = { status: number; body: any };
async function request(method: string, p: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function upload(p: string, file: { bytes: Uint8Array; type: string; name: string } | null, token?: string): Promise<Res> {
  const form = new FormData();
  if (file) form.append("file", new Blob([file.bytes], { type: file.type }), file.name);
  else form.append("note", "nothing attached");
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: form });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function login(email: string): Promise<string> {
  const r = await request("POST", "/auth/login", { email, password: PASSWORD });
  const token = r.body?.data?.accessToken as string | undefined;
  if (!token) throw new Error(`login failed for ${email}: ${r.status} ${show(r.body)}`);
  return token;
}

// ── Small images, and a server for them ─────────────────────────────────────
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const OWN_PNG = b64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==");
const ORG_PNG = b64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");
const JPEG = b64("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=");
const GIF = b64("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
// A PNG signature and then 2.1 MB: a PNG in name, too big in fact.
const BIG_PNG = new Uint8Array(2_200_000);
BIG_PNG.set(OWN_PNG.subarray(0, 8));
const dataUrl = (kind: "png" | "jpeg", bytes: Uint8Array) => `data:image/${kind};base64,${Buffer.from(bytes).toString("base64")}`;

const served: Record<string, { type: string; bytes: Uint8Array }> = {
  "/own.png": { type: "image/png", bytes: OWN_PNG },
  "/org.png": { type: "image/png", bytes: ORG_PNG },
  "/photo.jpg": { type: "image/jpeg", bytes: JPEG },
  "/big.png": { type: "image/png", bytes: BIG_PNG },
  // Says it is an image; is not one.
  "/not-image": { type: "image/png", bytes: new TextEncoder().encode("<html>not a picture</html>") },
};

async function main() {
  await mongoose.connect(uri);
  if (mongoose.connection.host !== "127.0.0.1" || !/e2e/.test(mongoose.connection.db!.databaseName)) {
    console.error(`Refusing to run: connected to ${mongoose.connection.host}/${mongoose.connection.db!.databaseName}`);
    process.exit(1);
  }
  const images = http.createServer((req, res) => {
    const file = served[req.url ?? ""];
    if (!file) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not here"); return; }
    res.writeHead(200, { "content-type": file.type, "content-length": String(file.bytes.byteLength) });
    res.end(Buffer.from(file.bytes));
  }).listen(Number(process.env.E2E_IMAGE_PORT ?? "4138"), "127.0.0.1");

  step("An organization, an admin, a salesperson who reads only their own, a customer");
  const org = await Organization.create({ name: "Branding E2E", baseCurrency: "AED" });
  for (const def of SYSTEM_ROLES) {
    await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
  }
  const adminRole = (await Role.findOne({ organizationId: org._id, key: "admin" }).lean())!._id;
  const ownOnly = await Role.create({ organizationId: org._id, key: "own-reader", name: "Own reader", description: "", permissions: ["invoice:read:own"], isSystem: false });
  const passwordHash = await hashPassword(PASSWORD);
  const mk = (name: string, email: string, roleId: Types.ObjectId) =>
    User.create({ name, email, passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId, status: "active" }] });
  const admin = await mk("Admin", "admin@e2e-branding.test", adminRole as Types.ObjectId);
  const rep = await mk("Rep", "rep@e2e-branding.test", ownOnly._id);
  const customer = await Customer.create({
    organizationId: org._id, customerCode: "CUS-00001", name: "Client One", email: "client@e2e-branding.test",
    phone: "+971500000000", currency: "AED", status: "active",
  });
  const tAdmin = await login("admin@e2e-branding.test");
  const tRep = await login("rep@e2e-branding.test");

  const today = new Date().toISOString().slice(0, 10);
  const later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const setOrgLogo = (logoUrl: string) => request("PATCH", "/organizations/settings", { branding: { logoUrl } }, tAdmin);
  /** An invoice made while the organization's logo was `logoUrl` — so it keeps that one. */
  async function invoiceUnder(logoUrl: string, totalMinor = 100_000, salespersonId = String(admin._id)): Promise<string> {
    const set = await setOrgLogo(logoUrl);
    if (set.status !== 200) throw new Error(`logo not set: ${show(set.body)}`);
    const r = await request("POST", "/invoices", {
      customerId: String(customer._id), salespersonId, issueDate: today, dueDate: later, currency: "AED",
      lineItems: [{ description: "Course fee", quantity: 1, unitPriceMinor: totalMinor }],
    }, tAdmin);
    if (!r.body?.data?.id) throw new Error(`invoice failed: ${show(r.body)}`);
    return r.body.data.id as string;
  }
  const logoOf = async (id: string, token = tAdmin) => request("GET", `/invoices/${id}/logo`, undefined, token);

  step("Uploading a logo in settings");
  const png = { bytes: ORG_PNG, type: "image/png", name: "logo.png" };
  check("nothing attached is refused", (await upload("/organizations/logo", null, tAdmin)).status === 422);
  const gif = await upload("/organizations/logo", { bytes: GIF, type: "image/gif", name: "logo.gif" }, tAdmin);
  check("a GIF is refused — a PDF cannot draw it", gif.status === 422 && /PNG or JPG/.test(gif.body?.error?.message ?? ""), show(gif.body));
  const renamed = await upload("/organizations/logo", { bytes: GIF, type: "image/png", name: "logo.png" }, tAdmin);
  check("so is a GIF that calls itself a PNG: the bytes decide", renamed.status === 422 && /PNG or JPG/.test(renamed.body?.error?.message ?? ""), show(renamed.body));
  const big = await upload("/organizations/logo", { bytes: BIG_PNG, type: "image/png", name: "big.png" }, tAdmin);
  check("a PNG over 2 MB is refused", big.status === 422 && /2 MB/.test(big.body?.error?.message ?? ""), show(big.body));
  const noStorage = await upload("/organizations/logo", png, tAdmin);
  check("a good PNG on a server with no file storage: it says so, plainly",
    noStorage.status === 422 && /storage is not set up/.test(noStorage.body?.error?.message ?? ""), show(noStorage.body));
  check("and the logo is left as it was", (await request("GET", "/organizations/settings", undefined, tAdmin)).body?.data?.branding?.logoUrl === "");
  check("somebody who may not change the settings cannot upload one", (await upload("/organizations/logo", png, tRep)).status === 403);
  check("nor can nobody", (await upload("/organizations/logo", png)).status === 401);

  step("The logo an invoice's PDF is drawn with");
  const withOwn = await invoiceUnder(`${IMAGES}/own.png`);
  const withNone = await invoiceUnder("");
  const withBroken = await invoiceUnder(`${IMAGES}/missing`);
  const withFake = await invoiceUnder(`${IMAGES}/not-image`);
  const withJpeg = await invoiceUnder(`${IMAGES}/photo.jpg`);
  const withBig = await invoiceUnder(`${IMAGES}/big.png`);
  const repsOwn = await invoiceUnder("", 50_000, String(rep._id));
  await setOrgLogo(`${IMAGES}/org.png`);

  check("its own, where it was made under one", (await logoOf(withOwn)).body?.data?.dataUrl === dataUrl("png", OWN_PNG));
  check("else the organization's now — one made before there was a logo does not go out without one",
    (await logoOf(withNone)).body?.data?.dataUrl === dataUrl("png", ORG_PNG));
  check("a link that no longer answers: the organization's", (await logoOf(withBroken)).body?.data?.dataUrl === dataUrl("png", ORG_PNG));
  check("a link to something that is not a picture: the organization's", (await logoOf(withFake)).body?.data?.dataUrl === dataUrl("png", ORG_PNG));
  check("a JPEG is drawn as a JPEG", (await logoOf(withJpeg)).body?.data?.dataUrl?.startsWith("data:image/jpeg;base64,"));
  check("one over 2 MB is passed over", (await logoOf(withBig)).body?.data?.dataUrl === dataUrl("png", ORG_PNG));
  await setOrgLogo(`${IMAGES}/not-image`);
  const lastResort = (await logoOf(withNone)).body?.data;
  check("with neither usable, Delta's — or, offline, none at all, never the broken one",
    lastResort && (lastResort.dataUrl === null || (lastResort.dataUrl.startsWith("data:image/png;base64,") && lastResort.dataUrl !== dataUrl("png", ORG_PNG))), show(lastResort));
  await setOrgLogo(`${IMAGES}/org.png`);

  check("somebody who reads only their own invoices gets nothing of another's", (await logoOf(withOwn, tRep)).status === 404);
  check("and their own invoice's logo", (await logoOf(repsOwn, tRep)).body?.data?.dataUrl === dataUrl("png", ORG_PNG));
  check("not signed in is refused", (await request("GET", `/invoices/${withOwn}/logo`)).status === 401);

  step("The PDF");
  const invoice = (await request("GET", `/invoices/${withOwn}`, undefined, tAdmin)).body?.data;
  const settings = (await request("GET", "/organizations/settings", undefined, tAdmin)).body?.data;
  const drawn = buildInvoicePdf({ invoice, org: settings, logo: dataUrl("png", OWN_PNG) }).output();
  const plain = buildInvoicePdf({ invoice, org: settings }).output();
  const unusable = buildInvoicePdf({ invoice, org: settings, logo: "data:image/gif;base64,R0lGODlh" }).output();
  check("with a logo, the file carries it as an image", drawn.includes("/Subtype /Image"));
  check("without one, it is drawn as before — the name, no image", !plain.includes("/Subtype /Image") && plain.includes("Branding E2E"));
  check("one it cannot draw is left out rather than breaking the file", !unusable.includes("/Subtype /Image") && unusable.includes("%%EOF"));
  check("the name is there either way", drawn.includes("Branding E2E"));

  step("A payment over the balance");
  const due = await invoiceUnder(`${IMAGES}/org.png`, 120_000);
  await request("POST", `/invoices/${due}/send`, undefined, tAdmin);
  const over = await request("POST", `/invoices/${due}/payments`, { method: "bank_transfer", amountMinor: 225_000, paidOn: today }, tAdmin);
  check("is turned down, in dirhams rather than fils",
    over.status === 409 && over.body?.error?.message === "AED 2,250.00 is more than the balance due of AED 1,200.00", show(over.body));
  const exact = await request("POST", `/invoices/${due}/payments`, { method: "bank_transfer", amountMinor: 120_000, paidOn: today }, tAdmin);
  check("the balance itself is taken", exact.status === 201 || exact.status === 200, show(exact.body));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  images.close();
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
