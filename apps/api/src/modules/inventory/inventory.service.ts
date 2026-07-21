import { Types } from "mongoose";
import type {
  CreateItemInput, UpdateItemInput, Item as ItemDTO,
  CreateWarehouseInput, UpdateWarehouseInput, Warehouse as WarehouseDTO,
  StockLevel as StockLevelDTO,
  StockMovement as StockMovementDTO,
  AdjustStockInput,
  CreatePriceListInput, UpdatePriceListInput, PriceList as PriceListDTO,
  ItemQuery, WarehouseQuery, StockMovementQuery,
  Paginated, ValuationReport,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { nextNumber } from "../sequence/sequence.service";
import { Item, type ItemDoc } from "./item.model";
import { Warehouse, type WarehouseDoc } from "./warehouse.model";
import { StockLevel, type StockLevelDoc } from "./stock-level.model";
import { StockMovement, type StockMovementDoc } from "./stock-movement.model";
import { PriceList, type PriceListDoc } from "./price-list.model";
import { Department } from "../department/department.model";

// ── DTO helpers ───────────────────────────────────────────────────────────────

/** Maps a (possibly populated) departmentId to the DTO ref. */
function toDepartmentRef(raw: unknown): { id: string; name: string } | null {
  if (!raw) return null;
  const d = raw as { _id?: Types.ObjectId; name?: string };
  if (d._id && typeof d.name === "string") return { id: d._id.toString(), name: d.name };
  return null;
}

async function requireOrgDepartment(orgId: string, departmentId: string) {
  const dept = await Department.findOne({ _id: departmentId, organizationId: orgId });
  if (!dept) throw new AppError("VALIDATION_ERROR", "Invalid department selected");
  return dept;
}

function itemToDTO(doc: ItemDoc, totalStock = 0): ItemDTO {
  return {
    id: doc._id.toString(),
    itemNumber: doc.itemNumber as string,
    name: doc.name,
    description: (doc.description as string) ?? "",
    sku: doc.sku,
    type: doc.type as ItemDTO["type"],
    unit: doc.unit as ItemDTO["unit"],
    unitPriceMinor: (doc.unitPriceMinor as number) ?? 0,
    costPriceMinor: (doc.costPriceMinor as number) ?? 0,
    trackStock: (doc.trackStock as boolean) ?? true,
    reorderPoint: (doc.reorderPoint as number) ?? 0,
    reorderQty: (doc.reorderQty as number) ?? 0,
    photoUrl: (doc.photoUrl as string | undefined) ?? undefined,
    department: toDepartmentRef((doc as unknown as { departmentId?: unknown }).departmentId),
    isActive: (doc.isActive as boolean) ?? true,
    totalStock,
    isLowStock: (doc.trackStock as boolean) && totalStock <= (doc.reorderPoint as number),
    createdAt: (doc as unknown as { createdAt: Date }).createdAt.toISOString(),
  };
}

function warehouseToDTO(doc: WarehouseDoc): WarehouseDTO {
  return {
    id: doc._id.toString(),
    name: doc.name,
    location: (doc.location as string) ?? "",
    isDefault: (doc.isDefault as boolean) ?? false,
    isActive: (doc.isActive as boolean) ?? true,
    createdAt: (doc as unknown as { createdAt: Date }).createdAt.toISOString(),
  };
}

function stockLevelToDTO(doc: StockLevelDoc): StockLevelDTO {
  const qty = (doc.quantityOnHand as number) ?? 0;
  const cost = (doc.avgCostMinor as number) ?? 0;
  return {
    id: doc._id.toString(),
    itemId: doc.itemId.toString(),
    itemName: doc.itemName as string,
    sku: doc.sku as string,
    warehouseId: doc.warehouseId.toString(),
    warehouseName: doc.warehouseName as string,
    quantityOnHand: qty,
    avgCostMinor: cost,
    valuationMinor: Math.round(qty * cost),
  };
}

function movementToDTO(doc: StockMovementDoc): StockMovementDTO {
  return {
    id: doc._id.toString(),
    itemId: doc.itemId.toString(),
    itemName: doc.itemName as string,
    sku: doc.sku as string,
    warehouseId: doc.warehouseId.toString(),
    warehouseName: doc.warehouseName as string,
    movementType: doc.movementType as StockMovementDTO["movementType"],
    quantity: doc.quantity as number,
    unitCostMinor: (doc.unitCostMinor as number) ?? 0,
    totalCostMinor: (doc.totalCostMinor as number) ?? 0,
    beforeQty: doc.beforeQty as number,
    afterQty: doc.afterQty as number,
    reference: (doc.reference as string) ?? "",
    referenceType: doc.referenceType as StockMovementDTO["referenceType"],
    referenceId: (doc.referenceId as string | undefined) ?? undefined,
    adjustmentReason: (doc.adjustmentReason as StockMovementDTO["adjustmentReason"]) ?? undefined,
    notes: (doc.notes as string) ?? "",
    createdByName: (doc.createdByName as string) ?? "",
    movementDate: (doc.movementDate as unknown as Date).toISOString().slice(0, 10),
    createdAt: (doc as unknown as { createdAt: Date }).createdAt.toISOString(),
  };
}

function priceListToDTO(doc: PriceListDoc): PriceListDTO {
  const entries = (doc.entries as unknown as {
    itemId: Types.ObjectId; itemName: string; sku: string;
    unitPriceMinor: number; discountPct: number; markupPct: number;
  }[]).map((e) => ({
    itemId: e.itemId.toString(),
    itemName: e.itemName ?? "",
    sku: e.sku ?? "",
    unitPriceMinor: e.unitPriceMinor,
    discountPct: e.discountPct ?? 0,
    markupPct: e.markupPct ?? 0,
  }));
  return {
    id: doc._id.toString(),
    name: doc.name,
    description: (doc.description as string) ?? "",
    isDefault: (doc.isDefault as boolean) ?? false,
    currency: (doc.currency as string) ?? "AED",
    validFrom: doc.validFrom ? (doc.validFrom as unknown as Date).toISOString().slice(0, 10) : undefined,
    validTo: doc.validTo ? (doc.validTo as unknown as Date).toISOString().slice(0, 10) : undefined,
    entries,
    createdAt: (doc as unknown as { createdAt: Date }).createdAt.toISOString(),
  };
}

// ── Internal: update stock level and record movement ─────────────────────────

async function applyStockChange(opts: {
  orgId: string;
  itemId: string;
  itemName: string;
  sku: string;
  warehouseId: string;
  warehouseName: string;
  delta: number;
  unitCostMinor: number;
  movementType: StockMovementDoc["movementType"];
  reference: string;
  referenceType: StockMovementDoc["referenceType"];
  referenceId?: string;
  adjustmentReason?: StockMovementDoc["adjustmentReason"];
  notes: string;
  createdByName: string;
  movementDate?: Date;
}): Promise<void> {
  const {
    orgId, itemId, itemName, sku, warehouseId, warehouseName,
    delta, unitCostMinor, movementType, reference, referenceType,
    referenceId, adjustmentReason, notes, createdByName,
  } = opts;
  const movementDate = opts.movementDate ?? new Date();

  const level = await StockLevel.findOneAndUpdate(
    {
      organizationId: new Types.ObjectId(orgId),
      itemId: new Types.ObjectId(itemId),
      warehouseId: new Types.ObjectId(warehouseId),
    },
    {
      $setOnInsert: { itemName, sku, warehouseName },
    },
    { upsert: true, new: false },
  );

  const beforeQty = (level?.quantityOnHand as number) ?? 0;
  const afterQty = beforeQty + delta;

  // Weighted-average cost update on stock-in movements
  let newAvgCost = (level?.avgCostMinor as number) ?? unitCostMinor;
  if (delta > 0 && unitCostMinor > 0) {
    const prevValue = beforeQty * newAvgCost;
    const addedValue = delta * unitCostMinor;
    newAvgCost = beforeQty + delta > 0
      ? Math.round((prevValue + addedValue) / (beforeQty + delta))
      : unitCostMinor;
  }

  await StockLevel.updateOne(
    {
      organizationId: new Types.ObjectId(orgId),
      itemId: new Types.ObjectId(itemId),
      warehouseId: new Types.ObjectId(warehouseId),
    },
    { $set: { quantityOnHand: afterQty, avgCostMinor: newAvgCost } },
  );

  await StockMovement.create({
    organizationId: new Types.ObjectId(orgId),
    itemId: new Types.ObjectId(itemId),
    itemName, sku,
    warehouseId: new Types.ObjectId(warehouseId),
    warehouseName,
    movementType,
    quantity: Math.abs(delta),
    unitCostMinor,
    totalCostMinor: Math.round(Math.abs(delta) * unitCostMinor),
    beforeQty,
    afterQty,
    reference,
    referenceType,
    referenceId,
    adjustmentReason,
    notes,
    createdByName,
    movementDate,
  });
}

// ── Items ─────────────────────────────────────────────────────────────────────

const ITEM_SORT: Record<string, string> = {
  name: "name", sku: "sku", type: "type", unit: "unit",
  price: "unitPriceMinor", cost: "costPriceMinor", createdAt: "createdAt",
};

export async function createItem(
  orgId: string,
  input: CreateItemInput,
): Promise<ItemDTO> {
  const existing = await Item.findOne({
    organizationId: new Types.ObjectId(orgId),
    sku: input.sku,
  });
  if (existing) throw new AppError("CONFLICT", `SKU "${input.sku}" already exists`);

  const itemNumber = await nextNumber(orgId, "item", "ITEM-");
  const { departmentId, ...rest } = input;
  const dept = departmentId ? await requireOrgDepartment(orgId, departmentId) : null;
  const doc = await Item.create({
    organizationId: new Types.ObjectId(orgId),
    itemNumber,
    ...rest,
    photoUrl: input.photoUrl || undefined,
    departmentId: dept?._id,
  });
  await doc.populate("departmentId", "name");
  return itemToDTO(doc, 0);
}

export async function updateItem(
  orgId: string,
  id: string,
  input: UpdateItemInput,
): Promise<ItemDTO> {
  if (input.sku) {
    const conflict = await Item.findOne({
      organizationId: new Types.ObjectId(orgId),
      sku: input.sku,
      _id: { $ne: new Types.ObjectId(id) },
    });
    if (conflict) throw new AppError("CONFLICT", `SKU "${input.sku}" already exists`);
  }
  const { departmentId, ...rest } = input;
  const update: Record<string, unknown> = { $set: { ...rest, photoUrl: input.photoUrl || undefined } };
  if (departmentId !== undefined) {
    if (departmentId) {
      const dept = await requireOrgDepartment(orgId, departmentId);
      (update.$set as Record<string, unknown>).departmentId = dept._id;
    } else {
      update.$unset = { departmentId: 1 };
    }
  }
  const doc = await Item.findOneAndUpdate(
    { _id: new Types.ObjectId(id), organizationId: new Types.ObjectId(orgId) },
    update,
    { new: true },
  ).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Item not found");
  const stock = await getTotalStock(orgId, id);
  return itemToDTO(doc, stock);
}

async function getTotalStock(orgId: string, itemId: string): Promise<number> {
  const levels = await StockLevel.find({
    organizationId: new Types.ObjectId(orgId),
    itemId: new Types.ObjectId(itemId),
  }).lean();
  return (levels as unknown as { quantityOnHand: number }[]).reduce(
    (sum, l) => sum + (l.quantityOnHand ?? 0), 0,
  );
}

export async function getItem(orgId: string, id: string): Promise<ItemDTO> {
  const doc = await Item.findOne({
    _id: new Types.ObjectId(id),
    organizationId: new Types.ObjectId(orgId),
  }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Item not found");
  const stock = await getTotalStock(orgId, id);
  return itemToDTO(doc, stock);
}

export async function listItems(
  orgId: string,
  query: ItemQuery,
): Promise<Paginated<ItemDTO>> {
  const { page, pageSize, sort, dir, q, type, trackStock, isActive, lowStock } = query;
  const filter: Record<string, unknown> = {
    organizationId: new Types.ObjectId(orgId),
  };
  if (type) filter.type = type;
  if (trackStock !== undefined) filter.trackStock = trackStock;
  if (isActive !== undefined) filter.isActive = isActive;

  const orClauses = searchOr(q, ["name", "sku", "description", "itemNumber"]);
  if (orClauses) Object.assign(filter, { $or: orClauses });

  const [docs, total] = await Promise.all([
    Item.find(filter)
      .sort(buildSort(ITEM_SORT, sort, dir, { createdAt: -1 }))
      .skip(skipFor(page, pageSize))
      .limit(pageSize)
      .populate("departmentId", "name")
      .lean(),
    Item.countDocuments(filter),
  ]);

  // Attach stock totals
  const ids = (docs as unknown as ItemDoc[]).map((d) => d._id);
  const levels = await StockLevel.find({
    organizationId: new Types.ObjectId(orgId),
    itemId: { $in: ids },
  }).lean();

  const stockMap = new Map<string, number>();
  for (const l of levels as unknown as StockLevelDoc[]) {
    const key = l.itemId.toString();
    stockMap.set(key, (stockMap.get(key) ?? 0) + ((l.quantityOnHand as number) ?? 0));
  }

  let items = (docs as unknown as ItemDoc[]).map((d) =>
    itemToDTO(d, stockMap.get(d._id.toString()) ?? 0),
  );

  if (lowStock) {
    items = items.filter((i) => i.isLowStock);
  }

  return { data: items, meta: pageMeta(lowStock ? items.length : total, page, pageSize) };
}

export async function deleteItem(orgId: string, id: string): Promise<void> {
  const doc = await Item.findOne({
    _id: new Types.ObjectId(id),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!doc) throw new AppError("NOT_FOUND", "Item not found");
  await doc.deleteOne();
}

// ── Warehouses ────────────────────────────────────────────────────────────────

const WH_SORT: Record<string, string> = { name: "name", createdAt: "createdAt" };

export async function createWarehouse(
  orgId: string,
  input: CreateWarehouseInput,
): Promise<WarehouseDTO> {
  if (input.isDefault) {
    await Warehouse.updateMany(
      { organizationId: new Types.ObjectId(orgId) },
      { $set: { isDefault: false } },
    );
  }
  const doc = await Warehouse.create({
    organizationId: new Types.ObjectId(orgId),
    ...input,
  });
  return warehouseToDTO(doc);
}

export async function updateWarehouse(
  orgId: string,
  id: string,
  input: UpdateWarehouseInput,
): Promise<WarehouseDTO> {
  if (input.isDefault) {
    await Warehouse.updateMany(
      { organizationId: new Types.ObjectId(orgId), _id: { $ne: new Types.ObjectId(id) } },
      { $set: { isDefault: false } },
    );
  }
  const doc = await Warehouse.findOneAndUpdate(
    { _id: new Types.ObjectId(id), organizationId: new Types.ObjectId(orgId) },
    { $set: input },
    { new: true },
  );
  if (!doc) throw new AppError("NOT_FOUND", "Warehouse not found");
  return warehouseToDTO(doc);
}

export async function listWarehouses(
  orgId: string,
  query: WarehouseQuery,
): Promise<Paginated<WarehouseDTO>> {
  const { page, pageSize, sort, dir, q, isActive } = query;
  const filter: Record<string, unknown> = {
    organizationId: new Types.ObjectId(orgId),
  };
  if (isActive !== undefined) filter.isActive = isActive;
  const orClauses = searchOr(q, ["name", "location"]);
  if (orClauses) Object.assign(filter, { $or: orClauses });

  const [docs, total] = await Promise.all([
    Warehouse.find(filter)
      .sort(buildSort(WH_SORT, sort, dir, { createdAt: -1 }))
      .skip(skipFor(page, pageSize))
      .limit(pageSize)
      .lean(),
    Warehouse.countDocuments(filter),
  ]);
  return {
    data: (docs as unknown as WarehouseDoc[]).map(warehouseToDTO),
    meta: pageMeta(total, page, pageSize),
  };
}

export async function getWarehouse(orgId: string, id: string): Promise<WarehouseDTO> {
  const doc = await Warehouse.findOne({
    _id: new Types.ObjectId(id),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!doc) throw new AppError("NOT_FOUND", "Warehouse not found");
  return warehouseToDTO(doc);
}

// ── Stock Levels ──────────────────────────────────────────────────────────────

export async function getStockLevels(
  orgId: string,
  itemId: string,
): Promise<StockLevelDTO[]> {
  const docs = await StockLevel.find({
    organizationId: new Types.ObjectId(orgId),
    itemId: new Types.ObjectId(itemId),
  }).lean();
  return (docs as unknown as StockLevelDoc[]).map(stockLevelToDTO);
}

// ── Stock Adjustments ─────────────────────────────────────────────────────────

export async function adjustStock(
  orgId: string,
  itemId: string,
  input: AdjustStockInput,
  createdByName: string,
): Promise<StockLevelDTO> {
  const item = await Item.findOne({
    _id: new Types.ObjectId(itemId),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!item) throw new AppError("NOT_FOUND", "Item not found");
  if (!item.trackStock) throw new AppError("CONFLICT", "Item does not track stock");

  const warehouse = await Warehouse.findOne({
    _id: new Types.ObjectId(input.warehouseId),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!warehouse) throw new AppError("NOT_FOUND", "Warehouse not found");

  const level = await StockLevel.findOne({
    organizationId: new Types.ObjectId(orgId),
    itemId: new Types.ObjectId(itemId),
    warehouseId: new Types.ObjectId(input.warehouseId),
  });
  const currentQty = (level?.quantityOnHand as number) ?? 0;
  const delta = input.newQuantity - currentQty;

  if (delta === 0) {
    return stockLevelToDTO(
      level ?? { _id: new Types.ObjectId(), organizationId: new Types.ObjectId(orgId), itemId: new Types.ObjectId(itemId), itemName: item.name as string, sku: item.sku as string, warehouseId: new Types.ObjectId(input.warehouseId), warehouseName: warehouse.name as string, quantityOnHand: currentQty, avgCostMinor: 0 } as unknown as StockLevelDoc,
    );
  }

  const movementType = delta > 0 ? "adjustment_in" : "adjustment_out";
  const costMinor = (item.costPriceMinor as number) ?? 0;

  await applyStockChange({
    orgId, itemId, itemName: item.name as string, sku: item.sku as string,
    warehouseId: input.warehouseId, warehouseName: warehouse.name as string,
    delta,
    unitCostMinor: costMinor,
    movementType,
    reference: `Adjustment: ${input.reason}`,
    referenceType: "adjustment",
    adjustmentReason: input.reason as StockMovementDoc["adjustmentReason"],
    notes: input.notes ?? "",
    createdByName,
    movementDate: input.movementDate ? new Date(input.movementDate) : new Date(),
  });

  const updated = await StockLevel.findOne({
    organizationId: new Types.ObjectId(orgId),
    itemId: new Types.ObjectId(itemId),
    warehouseId: new Types.ObjectId(input.warehouseId),
  });
  return stockLevelToDTO(updated!);
}

// ── Stock Movements ───────────────────────────────────────────────────────────

const MV_SORT: Record<string, string> = {
  date: "movementDate", type: "movementType", qty: "quantity", createdAt: "createdAt",
};

export async function listMovements(
  orgId: string,
  itemId: string,
  query: StockMovementQuery,
): Promise<Paginated<StockMovementDTO>> {
  const { page, pageSize, sort, dir, movementType, warehouseId, dateFrom, dateTo } = query;
  const filter: Record<string, unknown> = {
    organizationId: new Types.ObjectId(orgId),
    itemId: new Types.ObjectId(itemId),
  };
  if (movementType) filter.movementType = movementType;
  if (warehouseId) filter.warehouseId = new Types.ObjectId(warehouseId);
  if (dateFrom || dateTo) {
    const d: Record<string, Date> = {};
    if (dateFrom) d.$gte = new Date(dateFrom);
    if (dateTo) d.$lte = new Date(dateTo + "T23:59:59Z");
    filter.movementDate = d;
  }
  const [docs, total] = await Promise.all([
    StockMovement.find(filter)
      .sort(buildSort(MV_SORT, sort, dir, { movementDate: -1 }))
      .skip(skipFor(page, pageSize))
      .limit(pageSize)
      .lean(),
    StockMovement.countDocuments(filter),
  ]);
  return {
    data: (docs as unknown as StockMovementDoc[]).map(movementToDTO),
    meta: pageMeta(total, page, pageSize),
  };
}

// ── Invoice integration ───────────────────────────────────────────────────────

export async function deductStockForInvoice(
  orgId: string,
  invoiceId: string,
  invoiceNumber: string,
  lines: { itemId?: string; warehouseId?: string; quantity: number; description: string }[],
  createdByName: string,
): Promise<void> {
  for (const line of lines) {
    if (!line.itemId) continue;

    const item = await Item.findOne({
      _id: new Types.ObjectId(line.itemId),
      organizationId: new Types.ObjectId(orgId),
      trackStock: true,
      type: "product",
    });
    if (!item) continue;

    let warehouseId = line.warehouseId;
    let warehouseName = "";
    if (warehouseId) {
      const wh = await Warehouse.findOne({
        _id: new Types.ObjectId(warehouseId),
        organizationId: new Types.ObjectId(orgId),
      });
      warehouseName = (wh?.name as string) ?? "";
    } else {
      const defaultWh = await Warehouse.findOne({
        organizationId: new Types.ObjectId(orgId),
        isDefault: true,
        isActive: true,
      });
      if (!defaultWh) continue;
      warehouseId = defaultWh._id.toString();
      warehouseName = defaultWh.name as string;
    }

    await applyStockChange({
      orgId, itemId: line.itemId,
      itemName: item.name as string, sku: item.sku as string,
      warehouseId, warehouseName,
      delta: -line.quantity,
      unitCostMinor: (item.costPriceMinor as number) ?? 0,
      movementType: "invoice_out",
      reference: invoiceNumber,
      referenceType: "invoice",
      referenceId: invoiceId,
      notes: line.description,
      createdByName,
    });
  }
}

export async function restoreStockForInvoice(
  orgId: string,
  invoiceId: string,
  invoiceNumber: string,
  lines: { itemId?: string; warehouseId?: string; quantity: number; description: string }[],
  createdByName: string,
): Promise<void> {
  const movements = await StockMovement.find({
    organizationId: new Types.ObjectId(orgId),
    referenceId: invoiceId,
    referenceType: "invoice",
    movementType: "invoice_out",
  }).lean();

  for (const mv of movements as unknown as StockMovementDoc[]) {
    await applyStockChange({
      orgId,
      itemId: mv.itemId.toString(), itemName: mv.itemName as string, sku: mv.sku as string,
      warehouseId: mv.warehouseId.toString(), warehouseName: mv.warehouseName as string,
      delta: mv.quantity as number,
      unitCostMinor: (mv.unitCostMinor as number) ?? 0,
      movementType: "adjustment_in",
      reference: `Void of ${invoiceNumber}`,
      referenceType: "invoice",
      referenceId: invoiceId,
      adjustmentReason: "correction",
      notes: "Stock restored on invoice void",
      createdByName,
    });
  }
}

// ── Price Lists ───────────────────────────────────────────────────────────────

export async function createPriceList(
  orgId: string,
  input: CreatePriceListInput,
): Promise<PriceListDTO> {
  if (input.isDefault) {
    await PriceList.updateMany(
      { organizationId: new Types.ObjectId(orgId) },
      { $set: { isDefault: false } },
    );
  }
  // Denormalize item names
  const entries = await enrichEntries(orgId, input.entries ?? []);
  const doc = await PriceList.create({
    organizationId: new Types.ObjectId(orgId),
    ...input,
    entries,
    validFrom: input.validFrom ? new Date(input.validFrom) : undefined,
    validTo: input.validTo ? new Date(input.validTo) : undefined,
  });
  return priceListToDTO(doc);
}

export async function updatePriceList(
  orgId: string,
  id: string,
  input: UpdatePriceListInput,
): Promise<PriceListDTO> {
  if (input.isDefault) {
    await PriceList.updateMany(
      { organizationId: new Types.ObjectId(orgId), _id: { $ne: new Types.ObjectId(id) } },
      { $set: { isDefault: false } },
    );
  }
  const update: Record<string, unknown> = { ...input };
  if (input.entries) update.entries = await enrichEntries(orgId, input.entries);
  if (input.validFrom) update.validFrom = new Date(input.validFrom);
  if (input.validTo) update.validTo = new Date(input.validTo);

  const doc = await PriceList.findOneAndUpdate(
    { _id: new Types.ObjectId(id), organizationId: new Types.ObjectId(orgId) },
    { $set: update },
    { new: true },
  );
  if (!doc) throw new AppError("NOT_FOUND", "Price list not found");
  return priceListToDTO(doc);
}

async function enrichEntries(
  orgId: string,
  entries: CreatePriceListInput["entries"],
): Promise<{ itemId: Types.ObjectId; itemName: string; sku: string; unitPriceMinor: number; discountPct: number; markupPct: number }[]> {
  if (!entries || entries.length === 0) return [];
  const ids = entries.map((e) => new Types.ObjectId(e.itemId));
  const items = await Item.find({
    _id: { $in: ids },
    organizationId: new Types.ObjectId(orgId),
  }).lean();
  const itemMap = new Map(
    (items as unknown as ItemDoc[]).map((i) => [i._id.toString(), i]),
  );
  return entries.map((e) => {
    const item = itemMap.get(e.itemId);
    return {
      itemId: new Types.ObjectId(e.itemId),
      itemName: e.itemName || (item?.name as string) || "",
      sku: e.sku || (item?.sku as string) || "",
      unitPriceMinor: e.unitPriceMinor,
      discountPct: e.discountPct ?? 0,
      markupPct: e.markupPct ?? 0,
    };
  });
}

export async function listPriceLists(orgId: string): Promise<PriceListDTO[]> {
  const docs = await PriceList.find({
    organizationId: new Types.ObjectId(orgId),
  })
    .sort({ isDefault: -1, name: 1 })
    .lean();
  return (docs as unknown as PriceListDoc[]).map(priceListToDTO);
}

export async function getPriceList(orgId: string, id: string): Promise<PriceListDTO> {
  const doc = await PriceList.findOne({
    _id: new Types.ObjectId(id),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!doc) throw new AppError("NOT_FOUND", "Price list not found");
  return priceListToDTO(doc);
}

export async function deletePriceList(orgId: string, id: string): Promise<void> {
  const doc = await PriceList.findOne({
    _id: new Types.ObjectId(id),
    organizationId: new Types.ObjectId(orgId),
  });
  if (!doc) throw new AppError("NOT_FOUND", "Price list not found");
  await doc.deleteOne();
}

// ── Valuation Report (Avg Cost / FIFO approximation) ─────────────────────────

export async function getValuationReport(
  orgId: string,
  currency: string,
): Promise<ValuationReport> {
  const levels = await StockLevel.find({
    organizationId: new Types.ObjectId(orgId),
    quantityOnHand: { $gt: 0 },
  }).lean();

  if (levels.length === 0) {
    return {
      asOf: new Date().toISOString().slice(0, 10),
      currency,
      rows: [],
      totalValueMinor: 0,
    };
  }

  const itemIds = [...new Set((levels as unknown as StockLevelDoc[]).map((l) => l.itemId.toString()))];
  const items = await Item.find({
    _id: { $in: itemIds.map((id) => new Types.ObjectId(id)) },
    organizationId: new Types.ObjectId(orgId),
    type: "product",
  }).lean();
  const itemMap = new Map(
    (items as unknown as ItemDoc[]).map((i) => [i._id.toString(), i]),
  );

  const rows = (levels as unknown as StockLevelDoc[])
    .filter((l) => itemMap.has(l.itemId.toString()))
    .map((l) => {
      const item = itemMap.get(l.itemId.toString())!;
      const qty = (l.quantityOnHand as number) ?? 0;
      const cost = (l.avgCostMinor as number) ?? 0;
      return {
        itemId: l.itemId.toString(),
        itemNumber: item.itemNumber as string,
        name: item.name as string,
        sku: item.sku as string,
        unit: item.unit as ValuationReport["rows"][0]["unit"],
        warehouseId: l.warehouseId.toString(),
        warehouseName: l.warehouseName as string,
        quantityOnHand: qty,
        avgCostMinor: cost,
        valuationMinor: Math.round(qty * cost),
      };
    });

  const totalValueMinor = rows.reduce((sum, r) => sum + r.valuationMinor, 0);

  return {
    asOf: new Date().toISOString().slice(0, 10),
    currency,
    rows,
    totalValueMinor,
  };
}

// ── Low stock check ───────────────────────────────────────────────────────────

export async function getLowStockItems(orgId: string): Promise<ItemDTO[]> {
  const trackedItems = await Item.find({
    organizationId: new Types.ObjectId(orgId),
    trackStock: true,
    type: "product",
    isActive: true,
  }).lean();

  const ids = (trackedItems as unknown as ItemDoc[]).map((i) => i._id);
  const levels = await StockLevel.find({
    organizationId: new Types.ObjectId(orgId),
    itemId: { $in: ids },
  }).lean();

  const stockMap = new Map<string, number>();
  for (const l of levels as unknown as StockLevelDoc[]) {
    const key = l.itemId.toString();
    stockMap.set(key, (stockMap.get(key) ?? 0) + ((l.quantityOnHand as number) ?? 0));
  }

  return (trackedItems as unknown as ItemDoc[])
    .map((i) => itemToDTO(i, stockMap.get(i._id.toString()) ?? 0))
    .filter((i) => i.isLowStock);
}
