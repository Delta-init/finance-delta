"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateItemInput, UpdateItemInput, Item,
  CreateWarehouseInput, UpdateWarehouseInput, Warehouse,
  StockLevel, StockMovement, AdjustStockInput,
  CreatePriceListInput, UpdatePriceListInput, PriceList,
  ValuationReport,
} from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const INV = ["inventory"] as const;
const itemsKey = [...INV, "items"] as const;
const warehousesKey = [...INV, "warehouses"] as const;
const priceListsKey = [...INV, "price-lists"] as const;

// ── Items ─────────────────────────────────────────────────────────────────────

export function useItems(params: QueryParams = {}) {
  return useQuery({
    queryKey: [...itemsKey, params],
    queryFn: () => api.getList<Item>("inventory/items", params),
    placeholderData: (prev) => prev,
  });
}

export function useItem(id: string | undefined) {
  return useQuery({
    queryKey: [...itemsKey, id],
    queryFn: () => api.get<Item>(`inventory/items/${id}`),
    enabled: !!id,
  });
}

export function useLowStockItems() {
  return useQuery({
    queryKey: [...itemsKey, "low-stock"],
    queryFn: () => api.get<Item[]>("inventory/items/low-stock"),
    staleTime: 60_000,
  });
}

export function useCreateItem() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateItemInput) => api.post<Item>("inventory/items", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: itemsKey }),
  });
}

export function useUpdateItem(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateItemInput) => api.patch<Item>(`inventory/items/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: itemsKey });
      qc.invalidateQueries({ queryKey: [...itemsKey, id] });
    },
  });
}

export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<{ deleted: boolean }>(`inventory/items/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: itemsKey }),
  });
}

// ── Stock ─────────────────────────────────────────────────────────────────────

export function useStockLevels(itemId: string | undefined) {
  return useQuery({
    queryKey: [...itemsKey, itemId, "stock"],
    queryFn: () => api.get<StockLevel[]>(`inventory/items/${itemId}/stock`),
    enabled: !!itemId,
  });
}

export function useStockMovements(itemId: string | undefined, params: QueryParams = {}) {
  return useQuery({
    queryKey: [...itemsKey, itemId, "movements", params],
    queryFn: () => api.getList<StockMovement>(`inventory/items/${itemId}/movements`, params),
    enabled: !!itemId,
    placeholderData: (prev) => prev,
  });
}

export function useAdjustStock(itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: AdjustStockInput) =>
      api.post<StockLevel>(`inventory/items/${itemId}/adjust`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: itemsKey });
      qc.invalidateQueries({ queryKey: [...itemsKey, itemId] });
    },
  });
}

// ── Warehouses ────────────────────────────────────────────────────────────────

export function useWarehouses(params: QueryParams = {}) {
  return useQuery({
    queryKey: [...warehousesKey, params],
    queryFn: () => api.getList<Warehouse>("inventory/warehouses", params),
    placeholderData: (prev) => prev,
  });
}

export function useWarehouse(id: string | undefined) {
  return useQuery({
    queryKey: [...warehousesKey, id],
    queryFn: () => api.get<Warehouse>(`inventory/warehouses/${id}`),
    enabled: !!id,
  });
}

export function useCreateWarehouse() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateWarehouseInput) =>
      api.post<Warehouse>("inventory/warehouses", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: warehousesKey }),
  });
}

export function useUpdateWarehouse(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateWarehouseInput) =>
      api.patch<Warehouse>(`inventory/warehouses/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: warehousesKey });
      qc.invalidateQueries({ queryKey: [...warehousesKey, id] });
    },
  });
}

// ── Price Lists ───────────────────────────────────────────────────────────────

export function usePriceLists() {
  return useQuery({
    queryKey: priceListsKey,
    queryFn: () => api.get<PriceList[]>("inventory/price-lists"),
  });
}

export function usePriceList(id: string | undefined) {
  return useQuery({
    queryKey: [...priceListsKey, id],
    queryFn: () => api.get<PriceList>(`inventory/price-lists/${id}`),
    enabled: !!id,
  });
}

export function useCreatePriceList() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreatePriceListInput) =>
      api.post<PriceList>("inventory/price-lists", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: priceListsKey }),
  });
}

export function useUpdatePriceList(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdatePriceListInput) =>
      api.patch<PriceList>(`inventory/price-lists/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: priceListsKey });
      qc.invalidateQueries({ queryKey: [...priceListsKey, id] });
    },
  });
}

export function useDeletePriceList() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<{ deleted: boolean }>(`inventory/price-lists/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: priceListsKey }),
  });
}

// ── Valuation ─────────────────────────────────────────────────────────────────

export function useValuationReport(currency = "AED") {
  return useQuery({
    queryKey: [...INV, "valuation", currency],
    queryFn: () => api.get<ValuationReport>(`inventory/valuation?currency=${currency}`),
    staleTime: 30_000,
  });
}
