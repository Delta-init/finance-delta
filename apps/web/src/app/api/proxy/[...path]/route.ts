import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

/**
 * BFF proxy. The browser calls /api/proxy/<resource>; this handler injects the
 * server-only access token (kept out of client JS) and forwards to the Express
 * API. Keeps tokens in the httpOnly session per docs/SECURITY.md.
 */
const API_URL =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:4000/api/v1";

async function forward(req: NextRequest, path: string[]) {
  // next-auth v5 uses the cookie name as the JWT encryption salt.
  // In production (HTTPS) the cookie is "__Secure-authjs.session-token";
  // in dev (HTTP) it is "authjs.session-token".
  // Passing secureCookie lets getToken() pick the right name AND salt.
  const secureCookie =
    req.nextUrl.protocol === "https:" ||
    process.env.NODE_ENV === "production";

  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
    secureCookie,
  });

  if (!token?.accessToken || token.error === "RefreshTokenError") {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Session expired" } },
      { status: 401 },
    );
  }

  const url = `${API_URL}/${path.join("/")}${req.nextUrl.search}`;
  const init: RequestInit = {
    method: req.method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token.accessToken}`,
    },
  };
  if (!["GET", "HEAD"].includes(req.method)) {
    init.body = await req.text();
  }

  const res = await fetch(url, init);
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  return forward(req, (await params).path);
}
export async function POST(req: NextRequest, { params }: Ctx) {
  return forward(req, (await params).path);
}
export async function PATCH(req: NextRequest, { params }: Ctx) {
  return forward(req, (await params).path);
}
export async function PUT(req: NextRequest, { params }: Ctx) {
  return forward(req, (await params).path);
}
export async function DELETE(req: NextRequest, { params }: Ctx) {
  return forward(req, (await params).path);
}
