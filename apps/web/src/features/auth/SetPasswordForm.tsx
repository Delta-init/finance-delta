"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Lock, Eye, EyeOff, CheckCircle2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const schema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters").max(128),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: "Both passwords must match",
    path: ["confirm"],
  });
type Values = z.infer<typeof schema>;

export function SetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [show, setShow] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { password: "", confirm: "" } });

  async function onSubmit(values: Values) {
    setFailed(null);
    try {
      const res = await fetch("/api/public/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: values.password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setFailed(body?.error?.message ?? "That link is no longer valid. Please request a new one.");
        return;
      }
      setDone(true);
    } catch {
      setFailed("Could not reach the server. Please try again.");
    }
  }

  // A link with nothing on the end of it. Worth saying plainly rather than
  // letting somebody type a password and only then be told.
  if (!token) {
    return (
      <div className="w-full max-w-sm space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10">
          <AlertCircle className="h-6 w-6 text-danger" />
        </div>
        <div>
          <h1 className="font-display text-xl font-semibold">This link is incomplete</h1>
          <p className="mt-2 text-sm text-foreground-muted">
            Open the link from your email exactly as it was sent, or ask for a new one.
          </p>
        </div>
        <Link href="/forgot-password" className="text-sm font-medium text-primary hover:text-primary/80">
          Request a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="w-full max-w-sm space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-success/10">
          <CheckCircle2 className="h-6 w-6 text-success" />
        </div>
        <div>
          <h1 className="font-display text-xl font-semibold">Password set</h1>
          <p className="mt-2 text-sm text-foreground-muted">You can sign in now.</p>
        </div>
        <Button className="w-full" onClick={() => router.push("/login")}>
          Go to sign in
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="w-full max-w-sm space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold">Choose a password</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          At least 8 characters. You&rsquo;ll use this to sign in from now on.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input
            id="password"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            className="pl-9 pr-9"
            {...register("password")}
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? "Hide password" : "Show password"}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        {errors.password && <p className="text-xs text-danger">{errors.password.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password</Label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <Input
            id="confirm"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            className="pl-9"
            {...register("confirm")}
          />
        </div>
        {errors.confirm && <p className="text-xs text-danger">{errors.confirm.message}</p>}
      </div>

      {failed && (
        <div className="space-y-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
          <p>{failed}</p>
          <Link href="/forgot-password" className="block font-medium underline">
            Request a new link
          </Link>
        </div>
      )}

      <Button type="submit" className="w-full" loading={isSubmitting}>
        Set password
      </Button>
    </form>
  );
}
