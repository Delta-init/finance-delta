import { z } from "zod";

// ── Enums ─────────────────────────────────────────────────────────────────────

export const itemUnitSchema = z.enum([
  "each", "kg", "g", "liter", "ml", "meter", "cm", "box", "set",
  "hour", "day", "pair", "dozen", "pack",
]);
export type ItemUnit = z.infer<typeof itemUnitSchema>;

export const ITEM_UNIT_LABELS: Record<ItemUnit, string> = {
  each: "Each", kg: "kg", g: "g", liter: "Liter", ml: "ml",
  meter: "Meter", cm: "cm", box: "Box", set: "Set",
  hour: "Hour", day: "Day", pair: "Pair", dozen: "Dozen", pack: "Pack",
};

export const itemTypeSchema = z.enum(["product", "service"]);
export type ItemType = z.infer<typeof itemTypeSchema>;

export const adjustmentReasonSchema = z.enum([
  "shrinkage", "damage", "write_off", "found", "correction", "opening_stock", "other",
]);
export type AdjustmentReason = z.infer<typeof adjustmentReasonSchema>;

export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  shrinkage: "Shrinkage", damage: "Damage", write_off: "Write-off",
  found: "Found (surplus)", correction: "Correction", opening_stock: "Opening Stock", other: "Other",
};

export const movementTypeSchema = z.enum([
  "purchase_in", "invoice_out", "adjustment_in", "adjustment_out",
  "transfer_in", "transfer_out", "opening",
]);
export type MovementType = z.infer<typeof movementTypeSchema>;

export const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  purchase_in: "Purchase In", invoice_out: "Invoice Out",
  adjustment_in: "Adjustment In", adjustment_out: "Adjustment Out",
  transfer_in: "Transfer In", transfer_out: "Transfer Out",
  opening: "Opening Stock",
};

// ── Item ──────────────────────────────────────────────────────────────────────

export const createItemSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  description: z.string().optional().default(""),
  sku: z.string().min(1, "SKU is required").max(100),
  type: itemTypeSchema.default("product"),
  unit: itemUnitSchema.default("each"),
  unitPriceMinor: z.number().int().min(0).default(0),
  costPriceMinor: z.number().int().min(0).default(0),
  trackStock: z.boolean().default(true),
  reorderPoint: z.number().min(0).default(0),
  reorderQty: z.number().min(0).default(0),
  photoUrl: z.string().url().optional().or(z.literal("")),
  isActive: z.boolean().default(true),
});
export type CreateItemInput = z.infer<typeof createItemSchema>;

export const updateItemSchema = createItemSchema.partial();
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

export const itemSchema = z.object({
  id: z.string(),
  itemNumber: z.string(),
  name: z.string(),
  description: z.string(),
  sku: z.string(),
  type: itemTypeSchema,
  unit: itemUnitSchema,
  unitPriceMinor: z.number(),
  costPriceMinor: z.number(),
  trackStock: z.boolean(),
  reorderPoint: z.number(),
  reorderQty: z.number(),
  photoUrl: z.string().optional(),
  isActive: z.boolean(),
  totalStock: z.number(),
  isLowStock: z.boolean(),
  createdAt: z.string(),
});
export type Item = z.infer<typeof itemSchema>;

// ── Warehouse ─────────────────────────────────────────────────────────────────

export const createWarehouseSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  location: z.string().optional().default(""),
  isDefault: z.boolean().default(false),
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

export const updateWarehouseSchema = createWarehouseSchema.extend({ isActive: z.boolean().optional() }).partial();
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

export const warehouseSchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string(),
});
export type Warehouse = z.infer<typeof warehouseSchema>;

// ── Stock Level ───────────────────────────────────────────────────────────────

export const stockLevelSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  itemName: z.string(),
  sku: z.string(),
  warehouseId: z.string(),
  warehouseName: z.string(),
  quantityOnHand: z.number(),
  avgCostMinor: z.number(),
  valuationMinor: z.number(),
});
export type StockLevel = z.infer<typeof stockLevelSchema>;

// ── Stock Movement ────────────────────────────────────────────────────────────

export const stockMovementSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  itemName: z.string(),
  sku: z.string(),
  warehouseId: z.string(),
  warehouseName: z.string(),
  movementType: movementTypeSchema,
  quantity: z.number(),
  unitCostMinor: z.number(),
  totalCostMinor: z.number(),
  beforeQty: z.number(),
  afterQty: z.number(),
  reference: z.string(),
  referenceType: z.enum(["invoice", "purchase_order", "adjustment", "transfer", "manual"]),
  referenceId: z.string().optional(),
  adjustmentReason: adjustmentReasonSchema.optional(),
  notes: z.string(),
  createdByName: z.string(),
  movementDate: z.string(),
  createdAt: z.string(),
});
export type StockMovement = z.infer<typeof stockMovementSchema>;

// ── Stock Adjustment ──────────────────────────────────────────────────────────

export const adjustStockSchema = z.object({
  warehouseId: z.string().min(1, "Warehouse is required"),
  newQuantity: z.number().min(0, "Quantity cannot be negative"),
  reason: adjustmentReasonSchema,
  notes: z.string().optional().default(""),
  movementDate: z.string().optional(),
});
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

// ── Price List ────────────────────────────────────────────────────────────────

export const priceListEntrySchema = z.object({
  itemId: z.string(),
  itemName: z.string().optional().default(""),
  sku: z.string().optional().default(""),
  unitPriceMinor: z.number().int().min(0),
  discountPct: z.number().min(0).max(100).default(0),
  markupPct: z.number().min(0).default(0),
});
export type PriceListEntry = z.infer<typeof priceListEntrySchema>;

export const createPriceListSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  description: z.string().optional().default(""),
  isDefault: z.boolean().default(false),
  currency: z.string().min(3).max(3).default("AED"),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  entries: z.array(priceListEntrySchema).default([]),
});
export type CreatePriceListInput = z.infer<typeof createPriceListSchema>;

export const updatePriceListSchema = createPriceListSchema.partial();
export type UpdatePriceListInput = z.infer<typeof updatePriceListSchema>;

export const priceListSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  currency: z.string(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  entries: z.array(priceListEntrySchema),
  createdAt: z.string(),
});
export type PriceList = z.infer<typeof priceListSchema>;

// ── Valuation ─────────────────────────────────────────────────────────────────

export const valuationRowSchema = z.object({
  itemId: z.string(),
  itemNumber: z.string(),
  name: z.string(),
  sku: z.string(),
  unit: itemUnitSchema,
  warehouseId: z.string(),
  warehouseName: z.string(),
  quantityOnHand: z.number(),
  avgCostMinor: z.number(),
  valuationMinor: z.number(),
});
export type ValuationRow = z.infer<typeof valuationRowSchema>;

export const valuationReportSchema = z.object({
  asOf: z.string(),
  currency: z.string(),
  rows: z.array(valuationRowSchema),
  totalValueMinor: z.number(),
});
export type ValuationReport = z.infer<typeof valuationReportSchema>;
