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

  // When a user has multiple orgs and is in the picker step, the session holds
  // a short-lived pendingToken instead of a real accessToken.
  const effectiveToken =
    (token?.accessToken as string | undefined) ||
    (token?.needsOrgChoice ? (token.pendingToken as string | undefined) : undefined);

  if (!effectiveToken || token?.error === "RefreshTokenError") {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Session expired" } },
      { status: 401 },
    );
  }

  const url = `${API_URL}/${path.join("/")}${req.nextUrl.search}`;
  const contentType = req.headers.get("content-type") ?? "";
  const isMultipart = contentType.includes("multipart/form-data");

  const headers: Record<string, string> = {
    authorization: `Bearer ${effectiveToken}`,
  };
  if (!isMultipart) {
    headers["content-type"] = "application/json";
  } else {
    // Forward the original content-type header (includes the boundary param)
    headers["content-type"] = contentType;
  }

  const init: RequestInit = {
    method: req.method,
    headers,
  };
  if (!["GET", "HEAD"].includes(req.method)) {
    if (isMultipart) {
      init.body = await req.arrayBuffer();
    } else {
      init.body = await req.text();
    }
  }

  const res = await fetch(url, init);
  const text = await res.text();
  // Null-body statuses (204/205/304) must not carry a body — even "" throws.
  const body = [204, 205, 304].includes(res.status) ? null : text;
  return new NextResponse(body, {
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
