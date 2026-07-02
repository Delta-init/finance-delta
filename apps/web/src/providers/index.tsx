"use client";

import { SessionProvider, signOut } from "next-auth/react";
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
} from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { GoeyToaster } from "@/components/ui/goey-toaster";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { CurrencyProvider } from "@/lib/currency-context";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}

function handleError(error: unknown) {
  if (error instanceof ApiError && error.code === "UNAUTHENTICATED") {
    // Sign out from inside the React/SessionProvider tree so next-auth/react
    // has the context it needs. Calling signOut() from inside a queryFn
    // (outside React) caused the production crash.
    signOut({ callbackUrl: "/login" });
    return;
  }
  toast.error(errorMessage(error));
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: handleError,
        }),
        mutationCache: new MutationCache({
          onError: (error, _vars, _ctx, mutation) => {
            if ((mutation.meta as Record<string, unknown> | undefined)?.skipToast) return;
            handleError(error);
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <CurrencyProvider>
          {children}
          <GoeyToaster />
        </CurrencyProvider>
      </QueryClientProvider>
    </SessionProvider>
  );
}
