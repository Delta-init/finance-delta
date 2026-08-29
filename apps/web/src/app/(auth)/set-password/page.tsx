import { Suspense } from "react";
import { SetPasswordForm } from "@/features/auth/SetPasswordForm";
import { AuthShell } from "@/features/auth/AuthShell";

export default function SetPasswordPage() {
  return (
    <AuthShell>
      <Suspense fallback={null}>
        <SetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
