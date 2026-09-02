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

/**
 * Refetch everything a change to an account can touch.
 *
 * Invalidating ["bank-accounts", id] looks like it covers the lot, and misses
 * the one query that matters most: the account *list* is keyed
 * ["bank-accounts", params], which that prefix cannot match. So the balance in
 * a page header went on showing a figure from before the change while the rows
 * underneath it were right.
 *
 * Invalidating the root covers the list, the account, its transactions and its
 * counts in one go. A handful of extra refetches is a cheap price for never
 * showing two figures that disagree about the same tin.
 */
function refreshAccount(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ACCOUNTS_KEY });
}

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
    onSuccess: () => refreshAccount(qc),
  });
}

export function useUpdateBankAccount(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateBankAccountInput) =>
      api.patch<BankAccount>(`bank-accounts/${id}`, input),
    onSuccess: () => refreshAccount(qc),
  });
}

export function useDeactivateBankAccount(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: () => api.post<BankAccount>(`bank-accounts/${id}/deactivate`),
    onSuccess: () => refreshAccount(qc),
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
    onSuccess: () => refreshAccount(qc),
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
    onSuccess: () => refreshAccount(qc),
  });
}

export function useDeleteBankTransaction(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (txId: string) =>
      api.del<void>(`bank-accounts/${accountId}/transactions/${txId}`),
    onSuccess: () => refreshAccount(qc),
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
    onSuccess: () => refreshAccount(qc),
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
    onSuccess: () => refreshAccount(qc),
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
    onSuccess: () => refreshAccount(qc),
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
    onSuccess: () => refreshAccount(qc),
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
    onSuccess: () => refreshAccount(qc),
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
    onSuccess: () => refreshAccount(qc),
  });
}

/** Counting a tin: settles it in one go and posts any difference as an entry. */
export function useRecordCashCount(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CashCountInput) =>
      api.post<ReconciliationSession>(`bank-accounts/${accountId}/cash-count`, input),
    onSuccess: () => refreshAccount(qc),
  });
}

export function useUpdateCashCount(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ sessionId, input }: { sessionId: string; input: CashCountInput }) =>
      api.patch<ReconciliationSession>(`bank-accounts/${accountId}/cash-count/${sessionId}`, input),
    onSuccess: () => refreshAccount(qc),
  });
}

/** Withdraws a count: takes back its adjustment and releases the rows it locked. */
export function useDeleteCashCount(accountId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (sessionId: string) =>
      api.del<void>(`bank-accounts/${accountId}/cash-count/${sessionId}`),
    onSuccess: () => refreshAccount(qc),
  });
}
