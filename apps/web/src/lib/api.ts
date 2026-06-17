/**
 * Client-side API helper. Talks to the BFF proxy (/api/proxy/*), which injects
 * the access token server-side. Unwraps the `{ data }` envelope and throws a
 * typed ApiError on failure.
 *
 * Any 401 response immediately signs the user out and redirects to /login —
 * the session has expired and there is no valid token to recover.
 */
import { signOut } from "next-auth/react";

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function handleUnauthorized(): Promise<never> {
  await signOut({ callbackUrl: "/login" });
  throw new ApiError(401, "UNAUTHENTICATED", "Session expired");
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`/api/proxy/${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

  if (res.status === 401) return handleUnauthorized() as Promise<T>;
  if (res.status === 204) return undefined as T;

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json.error ?? {};
    throw new ApiError(
      res.status,
      err.code ?? "INTERNAL",
      err.message ?? "Request failed",
      err.details,
    );
  }
  return json.data as T;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export type QueryParams = Record<string, string | number | string[] | undefined | null>;

function qs(params?: QueryParams): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => x !== "" && sp.append(k, String(x)));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Server-side list fetch — returns the full `{ data, meta }` envelope. */
async function requestList<T>(path: string): Promise<{ data: T[]; meta: PageMeta }> {
  const res = await fetch(`/api/proxy/${path}`, {
    headers: { "content-type": "application/json" },
  });
  if (res.status === 401) return handleUnauthorized() as Promise<{ data: T[]; meta: PageMeta }>;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json.error ?? {};
    throw new ApiError(res.status, err.code ?? "INTERNAL", err.message ?? "Request failed", err.details);
  }
  return {
    data: (json.data ?? []) as T[],
    meta: (json.meta ?? { page: 1, pageSize: 10, total: 0, pageCount: 1 }) as PageMeta,
  };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  getList: <T>(path: string, params?: QueryParams) => requestList<T>(`${path}${qs(params)}`),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
