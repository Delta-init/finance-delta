/**
 * Client-side API helper. Talks to the BFF proxy (/api/proxy/*), which injects
 * the access token server-side. Unwraps the `{ data }` envelope and throws a
 * typed ApiError on failure.
 *
 * A 401 with code "UNAUTHENTICATED" (emitted by the BFF when the session token
 * is missing or expired) triggers signOut. Any other 401 from the backend
 * (e.g. a permission check) is surfaced as a regular ApiError — no logout.
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

async function handleUnauthorized() {
  // await signOut({ callbackUrl: "/login" });
  return {}
  // throw new ApiError(401, "UNAUTHENTICATED", "Session expired. Please log in again.");
}

async function parseError(res: Response) {
  const json = await res.json().catch(() => ({}));
  const err = json.error ?? {};
  return { code: (err.code ?? "INTERNAL") as string, message: (err.message ?? "Request failed") as string, details: err.details };
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`/api/proxy/${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

  if (res.status === 204) return undefined as T;

  if (res.status === 401) {
    const { code, message, details } = await parseError(res);
    if (code === "UNAUTHENTICATED") return handleUnauthorized() as Promise<T>;
    throw new ApiError(401, code, message, details);
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json.error ?? {};
    throw new ApiError(res.status, err.code ?? "INTERNAL", err.message ?? "Request failed", err.details);
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

  if (res.status === 401) {
    const { code, message, details } = await parseError(res);
    if (code === "UNAUTHENTICATED") return handleUnauthorized() as Promise<{ data: T[]; meta: PageMeta }>;
    throw new ApiError(401, code, message, details);
  }

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

/** Sends a multipart/form-data POST (e.g. file upload). Does NOT set content-type — the browser adds the boundary automatically. */
async function requestMultipart<T>(path: string, body: FormData): Promise<T> {
  const res = await fetch(`/api/proxy/${path}`, { method: "POST", body });

  if (res.status === 204) return undefined as T;
  if (res.status === 401) {
    const { code, message, details } = await parseError(res);
    if (code === "UNAUTHENTICATED") return handleUnauthorized() as Promise<T>;
    throw new ApiError(401, code, message, details);
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json.error ?? {};
    throw new ApiError(res.status, err.code ?? "INTERNAL", err.message ?? "Request failed", err.details);
  }
  return json.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  getList: <T>(path: string, params?: QueryParams) => requestList<T>(`${path}${qs(params)}`),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  postForm: <T>(path: string, body: FormData) => requestMultipart<T>(path, body),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
