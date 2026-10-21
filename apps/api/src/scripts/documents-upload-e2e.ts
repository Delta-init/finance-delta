/**
 * Documents are uploaded, never pasted (the user, 2026-10-20) — finance's services in the test itself.
 *
 * What it proves:
 *   - an expense's supporting documents are files uploaded through POST /expenses/uploads, sent back by key: a pasted
 *     link, a key outside this organization's uploads, or one climbing out of it is refused; the address is built
 *     here, never taken from the form;
 *   - editing an expense keeps each file's key, size and type (they used to be dropped on every save), keeps an old
 *     link already on it, and refuses a new link; renaming works;
 *   - the logo is uploaded: a pasted link is refused, the current one and this organization's uploads are kept;
 *   - an item's photo is uploaded: a pasted link is refused; a save that leaves the photo out keeps it; "" clears it.
 *
 * Run through scripts/documents-upload-e2e.sh (throwaway mongod, no .env anywhere, no file storage).
 */
import mongoose, { Types } from "mongoose";
import { createExpenseSchema, createItemSchema, updateExpenseSchema, updateItemSchema } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const FILES = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");

const { Organization } = await import("../modules/organization/organization.model");
const { User } = await import("../modules/user/user.model");
const { Role } = await import("../modules/role/role.model");
const { Expense } = await import("../modules/expense/expense.model");
const { updateOrganization } = await import("../modules/organization/organization.service") as any;
const ex = await import("../modules/expense/expense.service");
const inv = await import("../modules/inventory/inventory.service");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v).slice(0, 400);
const refusal = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const ALL = { all: true } as const;

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
await mongoose.connection.db!.dropDatabase();

const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED" });
const ORG = String(org._id), OTHER = new Types.ObjectId().toString();
const role = await Role.create({ organizationId: org._id, key: "accountant", name: "Accountant", permissions: ["expense:approve"] });
const asha = await User.create({ name: "Asha", email: "asha@e2e-docs.test", passwordHash: "x", status: "active", memberships: [{ organizationId: org._id, roleId: role._id, status: "active" }] });
const ASHA = String(asha._id);

const expense = (attachments: unknown[]) => ex.createExpense(ORG, ASHA, createExpenseSchema.parse({
  category: "travel_transport", subcategory: "business_taxi", description: "Taxi", expenseDate: new Date().toISOString().slice(0, 10), amountMinor: 10_000, currency: "AED",
  paymentMethod: "bank_transfer", attachments,
}) as never);
const mine = (name: string) => `expenses/${ORG}/uploads/${Date.now()}-abc-${name}`;

/* ── 1 ── */
step("1. An expense's documents: uploaded files only");
check("a pasted link: refused", /Upload the document — links are not accepted/.test(await refusal(expense([{ name: "Receipt", url: "https://evil.example/r.pdf" }]))));
check("a key outside this organization's uploads: refused", /not uploaded here/.test(await refusal(expense([{ name: "R", key: `expenses/${OTHER}/uploads/x.pdf` }]))));
check("…nor another expense's folder of this organization", /not uploaded here/.test(await refusal(expense([{ name: "R", key: `expenses/${ORG}/abc/x.pdf` }]))));
check("…nor one climbing out of it", /not uploaded here/.test(await refusal(expense([{ name: "R", key: `expenses/${ORG}/uploads/../../x.pdf` }]))));
check("eleven: refused", /at most 10/.test(await refusal(Promise.resolve().then(() => expense(Array.from({ length: 11 }, (_, i) => ({ name: `R${i}`, key: mine(`r${i}.pdf`) })))))));
const k1 = mine("receipt.pdf"), k2 = mine("photo.png");
const e1 = await expense([
  { name: "Receipt", key: k1, size: 1234, mimeType: "application/pdf", url: "https://evil.example/ignored" },
  { name: "Photo", key: k2, size: 99, mimeType: "image/png" },
]);
check("uploaded ones: saved with key, size and type", e1.attachments.length === 2 && e1.attachments[0]?.key === k1 && e1.attachments[0]?.size === 1234 && e1.attachments[0]?.mimeType === "application/pdf", j(e1.attachments));
check("…the address built here from the key, never the one sent", e1.attachments[0]?.url === `${FILES}/${k1}`, e1.attachments[0]?.url);
check("no storage on this server: uploading says so", /File storage is not configured/.test(await refusal(ex.uploadFormFile(ORG, { buffer: Buffer.from("x"), mimeType: "application/pdf", originalName: "r.pdf", size: 1 }))));

/* ── 2 ── */
step("2. Editing keeps what was stored");
const renamed = await ex.updateExpense(ORG, e1.id, updateExpenseSchema.parse({ attachments: [{ name: "Taxi receipt", key: k1 }, { name: "Photo", key: k2 }] }) as never, ALL);
check("renamed, and key, size, type kept (used to be dropped on save)", renamed.attachments[0]?.name === "Taxi receipt" && renamed.attachments[0]?.key === k1 && renamed.attachments[0]?.size === 1234 && renamed.attachments[0]?.mimeType === "application/pdf", j(renamed.attachments));
const dropped = await ex.updateExpense(ORG, e1.id, updateExpenseSchema.parse({ attachments: [{ name: "Taxi receipt", key: k1 }] }) as never, ALL);
check("one removed: the other stays", dropped.attachments.length === 1 && dropped.attachments[0]?.key === k1, j(dropped.attachments));
const other = await ex.updateExpense(ORG, e1.id, updateExpenseSchema.parse({ description: "Taxi to the bank" }) as never, ALL);
check("a save that doesn't send documents leaves them alone", other.attachments.length === 1 && other.attachments[0]?.key === k1, j(other.attachments));
await Expense.updateOne({ _id: e1.id }, { $push: { attachments: { name: "Old link", url: "https://drive.example/old.pdf" } } });
const legacy = await ex.updateExpense(ORG, e1.id, updateExpenseSchema.parse({ attachments: [{ name: "Taxi receipt", key: k1 }, { name: "Old link", url: "https://drive.example/old.pdf" }] }) as never, ALL);
check("an old link already on it: kept", legacy.attachments.some((a) => a.url === "https://drive.example/old.pdf" && !a.key), j(legacy.attachments));
check("…but no new link", /links are not accepted/.test(await refusal(ex.updateExpense(ORG, e1.id, updateExpenseSchema.parse({ attachments: [{ name: "New", url: "https://drive.example/new.pdf" }] }) as never, ALL))));

/* ── 3 ── */
step("3. The logo");
check("a pasted link: refused", /Upload the logo/.test(await refusal(updateOrganization(ORG, { branding: { logoUrl: "https://evil.example/logo.png" } }))));
const ownLogo = `${FILES}/branding/${ORG}/logo-1.png`;
check("this organization's upload: kept", (await updateOrganization(ORG, { branding: { logoUrl: ownLogo } })).branding.logoUrl === ownLogo);
check("saving the settings with the current one: fine", (await updateOrganization(ORG, { branding: { logoUrl: ownLogo, footerText: "Thanks" } })).branding.logoUrl === ownLogo);
check("another organization's: refused", /Upload the logo/.test(await refusal(updateOrganization(ORG, { branding: { logoUrl: `${FILES}/branding/${OTHER}/logo-1.png` } }))));
check("removed: \"\"", (await updateOrganization(ORG, { branding: { logoUrl: "" } })).branding.logoUrl === "");

/* ── 4 ── */
step("4. An item's photo");
const item = (photoUrl?: string) => inv.createItem(ORG, createItemSchema.parse({ name: `Book ${Math.random()}`, sku: `SKU-${Math.random()}`, type: "product", unit: "each", ...(photoUrl !== undefined ? { photoUrl } : {}) }) as never);
check("a pasted link: refused", /Upload the photo/.test(await refusal(item("https://evil.example/p.jpg"))));
const ownPhoto = `${FILES}/inventory/${ORG}/1-abc-book.jpg`;
const it = await item(ownPhoto);
check("this organization's upload: saved", it.photoUrl === ownPhoto, j(it));
const renamedItem = await inv.updateItem(ORG, it.id, updateItemSchema.parse({ name: "Book renamed" }) as never);
check("a save that leaves the photo out keeps it (it used to clear it)", renamedItem.photoUrl === ownPhoto, j(renamedItem));
check("…a new pasted link: refused", /Upload the photo/.test(await refusal(inv.updateItem(ORG, it.id, updateItemSchema.parse({ photoUrl: "https://evil.example/q.jpg" }) as never))));
const cleared = await inv.updateItem(ORG, it.id, updateItemSchema.parse({ photoUrl: "" }) as never);
check("\"\" clears it", !cleared.photoUrl, j(cleared));
check("no storage on this server: uploading says so, and a PDF is no photo", /JPG, PNG, WebP or GIF/.test(await refusal(inv.uploadItemPhoto(ORG, { buffer: Buffer.from("x"), mimeType: "application/pdf", originalName: "p.pdf", size: 1 })))
  && /File storage is not configured/.test(await refusal(inv.uploadItemPhoto(ORG, { buffer: Buffer.from("x"), mimeType: "image/png", originalName: "p.png", size: 1 }))));

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
