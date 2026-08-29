"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { motion } from "framer-motion";
import { Mail, Lock, Eye, EyeOff, LogIn } from "lucide-react";
import { useTopLoader } from "nextjs-toploader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/toast";
import {
  GoogleIcon,
  AppleIcon,
  MicrosoftIcon,
} from "@/components/brand-icons";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
  rememberMe: z.boolean().default(false),
});
type LoginValues = z.infer<typeof loginSchema>;

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const topLoader = useTopLoader();
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "", rememberMe: false },
  });

  async function onSubmit(values: LoginValues) {
    topLoader.start();
    const res = await signIn("credentials", {
      email: values.email,
      password: values.password,
      redirect: false,
    });

    if (res?.error) {
      topLoader.done();
      setError("root", { message: "Invalid email or password" });
      toast.error("Invalid email or password");
      return;
    }

    // Prompt browser to save credentials (AJAX logins skip the native prompt)
    const w = window as unknown as {
      PasswordCredential?: new (o: { id: string; password: string }) => Credential;
    };
    if (typeof window !== "undefined" && w.PasswordCredential) {
      try {
        const cred = new w.PasswordCredential({ id: values.email, password: values.password });
        await navigator.credentials.store(cred);
      } catch (_) {}
    }

    toast.success("Welcome back!");
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

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        {/* Email */}
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="eg. you@company.com"
              className="h-11 rounded-lg pl-10"
              aria-invalid={!!errors.email}
              {...register("email")}
            />
          </div>
          {errors.email && (
            <p className="text-xs text-danger" role="alert">{errors.email.message}</p>
          )}
        </div>

        {/* Password */}
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
              aria-invalid={!!errors.password}
              {...register("password")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-subtle transition-colors hover:text-foreground"
              aria-label={showPassword ? "Hide password" : "Show password"}
              tabIndex={-1}
            >
              {showPassword ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </button>
          </div>
          {errors.password && (
            <p className="text-xs text-danger" role="alert">{errors.password.message}</p>
          )}
        </div>

        {/* Remember me + Forgot password */}
        <div className="flex items-center justify-between pt-1">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground-muted select-none">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border accent-[var(--primary)]"
              {...register("rememberMe")}
            />
            Remember me
          </label>
          <Link
            href="/forgot-password"
            className="text-sm font-medium text-primary hover:text-primary/80"
          >
            Forgot Password?
          </Link>
        </div>

        {/* Server / root error */}
        {errors.root && (
          <div className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
            {errors.root.message}
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
