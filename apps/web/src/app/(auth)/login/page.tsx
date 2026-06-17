import { Suspense } from "react";
import { LoginForm } from "@/features/auth/LoginForm";
import { LoginShowcase } from "@/features/auth/LoginShowcase";

export default function LoginPage() {
  return (
    <div className="grid w-full max-w-full overflow-hidden  bg-surface h-screen lg:grid-cols-2">
      {/* Left — form */}
      <div className="relative flex flex-col px-6 py-8 sm:px-10 lg:px-12">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-display text-sm font-bold">
            Δ
          </span>
          <span className="font-display text-sm font-semibold tracking-tight">
            Delta Finance
          </span>
        </div>

        <div className="flex flex-1 items-center justify-center py-10">
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>
      </div>

      {/* Right — showcase */}
      <div className="hidden p-3 lg:block">
        <LoginShowcase />
      </div>
    </div>
  );
}
