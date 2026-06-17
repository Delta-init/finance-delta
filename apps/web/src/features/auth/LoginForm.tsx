"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { motion } from "framer-motion";
import { Mail, Lock, Eye, EyeOff, LogIn } from "lucide-react";
import { loginSchema, type LoginInput } from "@delta/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  GoogleIcon,
  AppleIcon,
  MicrosoftIcon,
} from "@/components/brand-icons";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: LoginInput) {
    setFormError(null);
    const res = await signIn("credentials", { ...values, redirect: false });
    if (res?.error) {
      setFormError("Invalid email or password");
      return;
    }
    router.push(params.get("callbackUrl") ?? "/dashboard");
    router.refresh();
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="relative mx-auto w-full max-w-[400px]"
    >
      {/* faint grid pattern behind the header */}
      <div
        className="pointer-events-none absolute -top-6 left-1/2 h-56 w-[140%] -translate-x-1/2"
        style={{
          maskImage:
            "radial-gradient(ellipse 60% 60% at 50% 40%, black, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 60% 60% at 50% 40%, black, transparent 75%)",
        }}
      >
        <div
          className="h-full w-full opacity-70"
          style={{
            backgroundImage:
              "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
            backgroundSize: "34px 34px",
          }}
        />
      </div>

      {/* header */}
      <div className="relative mb-8 flex flex-col items-center text-center">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-md shadow-primary/30">
          <LogIn className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Login to your account!
        </h1>
        <p className="mt-1.5 text-sm text-foreground-muted">
          Enter your registered email address and password to login!
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="eg. pixelcot@gmail.com"
              className="h-11 rounded-lg pl-10"
              {...register("email")}
            />
          </div>
          {errors.email && (
            <p className="text-xs text-danger">{errors.email.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="••••••••••••"
              className="h-11 rounded-lg pl-10 pr-10"
              {...register("password")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-subtle transition-colors hover:text-foreground"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? (
                <Eye className="h-4 w-4" />
              ) : (
                <EyeOff className="h-4 w-4" />
              )}
            </button>
          </div>
          {errors.password && (
            <p className="text-xs text-danger">{errors.password.message}</p>
          )}
        </div>

        <div className="flex items-center justify-between pt-1">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground-muted">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border accent-[var(--primary)]"
            />
            Remember me
          </label>
          <button
            type="button"
            className="text-sm font-medium text-primary hover:text-primary-700"
          >
            Forgot Password ?
          </button>
        </div>

        {formError && (
          <div className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
            {formError}
          </div>
        )}

        <Button
          type="submit"
          className="h-11 w-full rounded-lg text-sm"
          disabled={isSubmitting}
        >
          {isSubmitting ? "Signing in…" : "Login"}
        </Button>
      </form>

      {/* divider */}
      <div className="relative my-5 text-center">
        <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
        <span className="relative bg-surface px-3 text-xs text-foreground-subtle">
          Or login with
        </span>
      </div>

      {/* social (visual placeholders — OAuth not wired in this phase) */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { Icon: GoogleIcon, label: "Google" },
          { Icon: AppleIcon, label: "Apple" },
          { Icon: MicrosoftIcon, label: "Microsoft" },
        ].map(({ Icon, label }) => (
          <button
            key={label}
            type="button"
            title={`${label} sign-in (coming soon)`}
            className="flex h-11 items-center justify-center rounded-lg border border-border bg-surface transition-colors hover:bg-surface-muted"
            aria-label={`Continue with ${label}`}
          >
            <Icon className="h-5 w-5" />
          </button>
        ))}
      </div>
    </motion.div>
  );
}
