/**
 * Drives a Root portal handoff into finance, over real HTTP.
 *
 * The portal is stood up here rather than mocked: a small server that answers
 * `verify-sso-token` the way the real one does. The contract between the two
 * is the thing most likely to be wrong — a field renamed on either side shows
 * up as a blanket 401 with nothing to say which — so it is exercised across a
 * socket rather than asserted about.
 *
 * What matters most is what must NOT work. This server trusts whatever the
 * portal vouches for, so the refusals are the security: an unknown account
 * must not be created on demand, a suspended one must not be let in, and with
 * no portal configured the whole door must stay shut rather than falling back
 * to a default and asking itself.
 */
import mongoose, { Types } from "mongoose";
import { createServer, type Server } from "node:http";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

const PORT = process.env.E2E_API_PORT ?? "4119";
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = "E2ePassword1!";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(n: string) { console.log(`\n\x1b[1m${n}\x1b[0m`); }

/** The portal, answering the one endpoint finance calls. */
const issued = new Map<string, { email: string; name: string }>();
function startPortal(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (!url.pathname.endsWith("/api/auth/verify-sso-token")) {
      res.writeHead(404).end();
      return;
    }
    const token = url.searchParams.get("token") ?? "";
    const identity = issued.get(token);
    // Single use, as the real portal's atomic spend makes it.
    issued.delete(token);
    if (!identity) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "Invalid or expired SSO token" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { id: "portal-1", role: "Super Admin", ...identity } }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function mint(email: string, name: string): string {
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  issued.set(token, { email, name });
  return token;
}

type Res = { status: number; body: Record<string, never> };
async function post(p: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, never> };
}

async function main() {
  const portal = await startPortal(Number(process.env.E2E_PORTAL_PORT ?? 4120));
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();

  step("Setting up an organization");
  const org = await Organization.create({ name: "Delta HQ", baseCurrency: "AED" });
  for (const def of SYSTEM_ROLES) {
    await Role.create({
      organizationId: org._id, key: def.key, name: def.name,
      description: def.description, permissions: def.permissions, isSystem: true,
    });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const salesRoleId = String(roles.find((r) => r.key === "salesperson")!._id);

  await User.create({
    name: "Yamini", email: "yamini@e2e-test.com",
    passwordHash: await hashPassword(PASSWORD), status: "active",
    memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(salesRoleId), status: "active" }],
  });
  await User.create({
    name: "Former Staff", email: "former@e2e-test.com",
    passwordHash: await hashPassword(PASSWORD), status: "suspended",
    memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(salesRoleId), status: "active" }],
  });
  check("a salesperson exists here", true);

  // ── The handoff ───────────────────────────────────────────────────────────
  step("Signing in somebody the portal vouches for");
  {
    const r = await post("/auth/sso-login", { ssoToken: mint("yamini@e2e-test.com", "Yamini") });
    check("the handoff is accepted", r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);

    const data = r.body?.data as unknown as
      { accessToken?: string; user?: { email?: string; roleKey?: string; organizationId?: string } } | undefined;
    check("...and issues a real session", Boolean(data?.accessToken), "no accessToken");
    check("...for the right person", data?.user?.email === "yamini@e2e-test.com", `got ${data?.user?.email}`);
    // The whole point of reusing the password path: they arrive with the role
    // and organization they already had here, not something SSO invented.
    check("...with the role this system gave them", data?.user?.roleKey === "salesperson", `role=${data?.user?.roleKey}`);
    check("...inside their own organization", data?.user?.organizationId === String(org._id), `org=${data?.user?.organizationId}`);
  }

  // ── What must not work ────────────────────────────────────────────────────
  step("Refusing everything else");
  {
    const r = await post("/auth/sso-login", { ssoToken: "never-minted" });
    check("a token the portal does not know is refused", r.status === 401, `got ${r.status}`);
  }
  {
    // Single use: the portal spends it, so the second attempt finds nothing.
    const token = mint("yamini@e2e-test.com", "Yamini");
    const first = await post("/auth/sso-login", { ssoToken: token });
    const second = await post("/auth/sso-login", { ssoToken: token });
    check("a token works once", first.status === 200, `got ${first.status}`);
    check("...and not twice", second.status === 401, `got ${second.status}`);
  }
  {
    // The rule that stops a spoofed portal minting accounts here.
    const r = await post("/auth/sso-login", { ssoToken: mint("stranger@e2e-test.com", "Stranger") });
    check("somebody with no account here is refused", r.status === 401, `got ${r.status}`);
    const msg = String((r.body as unknown as { error?: { message?: string } })?.error?.message ?? "");
    check("...and told the account must be created first", /created here/i.test(msg), `"${msg}"`);
    check("...no account is created for them",
      (await User.countDocuments({ email: "stranger@e2e-test.com" })) === 0, "one was created");
  }
  {
    const r = await post("/auth/sso-login", { ssoToken: mint("former@e2e-test.com", "Former Staff") });
    check("a suspended account is refused", r.status === 403, `got ${r.status}`);
  }
  {
    const r = await post("/auth/sso-login", {});
    check("no token at all is refused", r.status === 422 || r.status === 400, `got ${r.status}`);
  }

  portal.close();
  await mongoose.disconnect();
  console.log("");
  if (failures) { console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`); process.exit(1); }
  console.log(`\x1b[32mAll ${checks} checks passed\x1b[0m`);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
