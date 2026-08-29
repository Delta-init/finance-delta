import { NextResponse, type NextRequest } from "next/server";

/**
 * Forwards the handful of API calls that happen before anybody is signed in.
 *
 * The ordinary proxy injects a session token and refuses without one, which is
 * right for everything except setting a password — the case where, by
 * definition, you cannot sign in yet.
 *
 * The allow-list is the whole point. Forwarding an arbitrary path without a
 * token would be an unauthenticated route into the entire API, which is a
 * considerably worse thing than the problem it solves.
 */
const ALLOWED = new Set(["auth/forgot-password", "auth/reset-password"]);

const API_URL =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:4000/api/v1";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const target = path.join("/");

  if (!ALLOWED.has(target)) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 },
    );
  }

  const res = await fetch(`${API_URL}/${target}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Passed through so the API's rate limiter throttles the browser that
      // made the request rather than this server, which every request shares.
      ...(req.headers.get("x-forwarded-for")
        ? { "x-forwarded-for": req.headers.get("x-forwarded-for")! }
        : {}),
    },
    body: await req.text(),
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
