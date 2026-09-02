"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateBankAccountInput,
  UpdateBankAccountInput,
  BankAccount,
  BankTransaction,
  ReconciliationSession,
  CreateBankTransactionInput,
  UpdateBankTransactionInput,
  BulkImportTransactionsInput,
  PreviewImportInput,
  MatchTransactionInput,
  StartReconciliationInput,
  UpdateReconciliationInput,
  CashCountInput,
} from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const ACCOUNTS_KEY = ["bank-accounts"] as const;
const txKey = (accountId: string) => [...ACCOUNTS_KEY, accountId, "transactions"] as const;
const reconcileKey = (accountId: string) => [...ACCOUNTS_KEY, accountId, "reconciliations"] as const;

// ── Accounts ──────────────────────────────────────────────────────────────────

export function useBankAccounts(params: QueryParams = {}) {
  return useQuery({
    queryKey: [...ACCOUNTS_KEY, params],
    queryFn: () => api.getList<BankAccount>("bank-accounts", params),
    placeholderData: (prev) => prev,
  });
}

export function useBankAccount(id: string | undefined) {
  return useQuery({
    queryKey: [...ACCOUNTS_KEY, id],
    queryFn: () => api.get<BankAccount>(`bank-accounts/${id}`),
    enabled: !!id,
  });
}

export function useCreateBankAccount() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateBankAccountInput) =>
      api.post<BankAccount>("bank-accounts", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
  });
}

export function useUpdateBankAccount(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateBankAccountInput) =>
      api.patch<BankAccount>(`bank-accounts/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, id] });
    },
  });
}

export function useDeactivateBankAccount(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: () => api.post<BankAccount>(`bank-accounts/${id}/deactivate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, id] });
    },
  });
}

// ── Transactions ──────────────────────────────────────────────────────────────

export function useBankTransactions(accountId: string, params: QueryParams = {}) {
  return useQuery({
    queryKey: [...txKey(accountId), params],
    queryFn: () => api.getList<BankTransaction>(`bank-accounts/${accountId}/transactions`, params),
    placeholderData: (prev) => prev,
    enabled: !!accountId,
  });
}

export function useCreateBankTransaction(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateBankTransactionInput) =>
      api.post<BankTransaction>(`bank-accounts/${accountId}/transactions`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: txKey(accountId) });
      qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, accountId] });
    },
  });
}

/**
 * Correcting or removing an entry.
 *
 * Both invalidate the account as well as the list: a change anywhere restates
 * the running balance down the whole statement and the account's own balance,
 * so the figures on screen above the table are stale too.
 */
export function useUpdateBankTransaction(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ txId, input }: { txId: string; input: UpdateBankTransactionInput }) =>
      api.patch<BankTransaction>(`bank-accounts/${accountId}/transactions/${txId}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: txKey(accountId) });
      qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, accountId] });
    },
  });
}

export function useDeleteBankTransaction(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (txId: string) =>
      api.del<void>(`bank-accounts/${accountId}/transactions/${txId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: txKey(accountId) });
      qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, accountId] });
    },
  });
}

/**
 * Asks the server which of these lines it already has, before anything is
 * written. Not cached — the answer depends on what was imported a moment ago.
 */
export function usePreviewImport(accountId: string) {
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: PreviewImportInput) =>
      api.post<{ total: number; duplicates: number[]; newCount: number }>(
        `bank-accounts/${accountId}/transactions/import-preview`,
        input,
      ),
  });
}

export function useBulkImportTransactions(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: BulkImportTransactionsInput) =>
      api.post<{ count: number; skipped: number; transactions: BankTransaction[] }>(
        `bank-accounts/${accountId}/transactions/bulk`,
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: txKey(accountId) });
      qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, accountId] });
    },
  });
}

function useTxAction(action: string, accountId: string, txId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (body?: unknown) =>
      body !== undefined
        ? api.post<BankTransaction>(
            `bank-accounts/${accountId}/transactions/${txId}/${action}`,
            body as Record<string, unknown>,
          )
        : api.post<BankTransaction>(
            `bank-accounts/${accountId}/transactions/${txId}/${action}`,
          ),
    onSuccess: () => qc.invalidateQueries({ queryKey: txKey(accountId) }),
  });
}

export const useMatchTransaction = (accountId: string, txId: string) => {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: MatchTransactionInput) =>
      api.post<BankTransaction>(
        `bank-accounts/${accountId}/transactions/${txId}/match`,
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: txKey(accountId) }),
  });
};
export const useUnmatchTransaction = (accountId: string, txId: string) =>
  useTxAction("unmatch", accountId, txId);
export const useExcludeTransaction = (accountId: string, txId: string) =>
  useTxAction("exclude", accountId, txId);
export const useMarkDuplicate = (accountId: string, txId: string) =>
  useTxAction("duplicate", accountId, txId);
/** The way back from excluded or duplicate — both were one-way. */
export const useRestoreTransaction = (accountId: string, txId: string) =>
  useTxAction("restore", accountId, txId);

// ── Reconciliation ────────────────────────────────────────────────────────────

export function useReconciliations(accountId: string, params: QueryParams = {}) {
  return useQuery({
    queryKey: [...reconcileKey(accountId), params],
    queryFn: () =>
      api.getList<ReconciliationSession>(
        `bank-accounts/${accountId}/reconciliations`,
        params,
      ),
    enabled: !!accountId,
  });
}

export function useReconciliation(accountId: string, sessionId: string | undefined) {
  return useQuery({
    queryKey: [...reconcileKey(accountId), sessionId],
    queryFn: () =>
      api.get<ReconciliationSession>(
        `bank-accounts/${accountId}/reconciliations/${sessionId}`,
      ),
    enabled: !!accountId && !!sessionId,
  });
}

export function useStartReconciliation(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: StartReconciliationInput) =>
      api.post<ReconciliationSession>(
        `bank-accounts/${accountId}/reconciliations`,
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: reconcileKey(accountId) }),
  });
}

export function useUpdateReconciliation(accountId: string, sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateReconciliationInput) =>
      api.patch<ReconciliationSession>(
        `bank-accounts/${accountId}/reconciliations/${sessionId}`,
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: reconcileKey(accountId) });
      qc.invalidateQueries({ queryKey: [...reconcileKey(accountId), sessionId] });
    },
  });
}

export function useCompleteReconciliation(accountId: string, sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: () =>
      api.post<ReconciliationSession>(
        `bank-accounts/${accountId}/reconciliations/${sessionId}/complete`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: reconcileKey(accountId) });
      qc.invalidateQueries({ queryKey: [...reconcileKey(accountId), sessionId] });
      qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, accountId] });
    },
  });
}

/** Counting a tin: settles it in one go and posts any difference as an entry. */
export function useRecordCashCount(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CashCountInput) =>
      api.post<ReconciliationSession>(`bank-accounts/${accountId}/cash-count`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: txKey(accountId) });
      qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, accountId] });
      qc.invalidateQueries({ queryKey: reconcileKey(accountId) });
    },
  });
}

export function useUpdateCashCount(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ sessionId, input }: { sessionId: string; input: CashCountInput }) =>
      api.patch<ReconciliationSession>(`bank-accounts/${accountId}/cash-count/${sessionId}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: txKey(accountId) });
      qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, accountId] });
      qc.invalidateQueries({ queryKey: reconcileKey(accountId) });
    },
  });
}

/** Withdraws a count: takes back its adjustment and releases the rows it locked. */
export function useDeleteCashCount(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (sessionId: string) =>
      api.del<void>(`bank-accounts/${accountId}/cash-count/${sessionId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: txKey(accountId) });
      qc.invalidateQueries({ queryKey: [...ACCOUNTS_KEY, accountId] });
      qc.invalidateQueries({ queryKey: reconcileKey(accountId) });
    },
  });
}
