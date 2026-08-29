import { Suspense } from "react";
import { ForgotPasswordForm } from "@/features/auth/ForgotPasswordForm";
import { AuthShell } from "@/features/auth/AuthShell";

export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      <Suspense fallback={null}>
        <ForgotPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
