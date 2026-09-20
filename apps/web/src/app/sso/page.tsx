"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Loader2, ShieldAlert } from "lucide-react";

/**
 * Landing page for a handoff from the Root portal.
 *
 * The portal redirects here with a one-time token in the query string. It is
 * handed straight to NextAuth's `sso` provider and never stored: the server
 * spends it against the portal, and what comes back is an ordinary session,
 * indistinguishable from one started by typing a password.
 *
 * The URL is scrubbed with replaceState the moment the token is read, so it
 * does not linger in the address bar, in history, or in a Referer header sent
 * by some later navigation.
 */
function Handoff() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  // React mounts effects twice in development. The token is single-use, so a
  // second attempt would always fail and show an error that is not real.
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const token = params.get("token");
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", window.location.pathname);
    }

    if (!token) {
      setError("This link carried no sign-in token.");
      return;
    }

    void signIn("sso", { ssoToken: token, redirect: false }).then((res) => {
      if (res?.ok) {
        router.replace("/dashboard");
        return;
      }
      // NextAuth reports a refused authorize() as a generic failure, so the
      // reason lives in the server's log rather than here. Say what can
      // actually be acted on instead of guessing at the cause.
      setError(
        "This sign-in link could not be used. It may have expired, already been used, or there may be no Delta Finance account for you yet.",
      );
    });
  }, [params, router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-border bg-surface p-6 text-center">
          <ShieldAlert className="mx-auto h-8 w-8 text-danger" />
          <h1 className="mt-3 text-lg font-semibold">Could not sign you in</h1>
          <p className="mt-2 text-sm text-foreground-muted">{error}</p>
          <button
            onClick={() => router.replace("/login")}
            className="mt-4 text-sm text-primary hover:underline"
          >
            Sign in with a password instead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3">
      <Loader2 className="h-6 w-6 animate-spin text-foreground-muted" />
      <p className="text-sm text-foreground-muted">Signing you in…</p>
    </div>
  );
}

export default function SsoPage() {
  // useSearchParams needs a Suspense boundary to prerender.
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-foreground-muted" />
        </div>
      }
    >
      <Handoff />
    </Suspense>
  );
}
