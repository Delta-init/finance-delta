"use client";

import { SessionProvider } from "next-auth/react";
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

function shouldToast(error: unknown): boolean {
  // UNAUTHENTICATED triggers redirect to /login — no toast needed on top of that
  if (error instanceof ApiError && error.code === "UNAUTHENTICATED") return false;
  return true;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          // Every failed query (initial load, background refetch) shows a toast.
          onError: (error) => {
            if (!shouldToast(error)) return;
            toast.error(errorMessage(error));
          },
        }),
        mutationCache: new MutationCache({
          // Global fallback for mutations. Form mutations that already call
          // toast.error in their own catch block should set meta: { skipToast: true }
          // on the useMutation call to avoid showing two toasts.
          onError: (error, _vars, _ctx, mutation) => {
            if ((mutation.meta as Record<string, unknown> | undefined)?.skipToast) return;
            if (!shouldToast(error)) return;
            toast.error(errorMessage(error));
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
