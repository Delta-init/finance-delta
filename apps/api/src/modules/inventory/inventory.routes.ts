import { Router } from "express";
import {
  createItemSchema, updateItemSchema, adjustStockSchema,
  createWarehouseSchema, updateWarehouseSchema,
  createPriceListSchema, updatePriceListSchema,
} from "@delta/shared";
import { authenticate } from "../../middleware/auth";
import { requirePermission } from "../../middleware/rbac";
import { validateBody } from "../../middleware/validate";
import * as c from "./inventory.controller";

const router = Router();
router.use(authenticate);

// Items
router.get("/items", requirePermission("inventory:read"), c.listItems);
router.get("/items/low-stock", requirePermission("inventory:read"), c.getLowStock);
router.get("/items/:id", requirePermission("inventory:read"), c.getItem);
router.post("/items", requirePermission("inventory:write"), validateBody(createItemSchema), c.createItem);
router.patch("/items/:id", requirePermission("inventory:write"), validateBody(updateItemSchema), c.updateItem);
router.delete("/items/:id", requirePermission("inventory:delete"), c.deleteItem);

// Stock per item
router.get("/items/:id/stock", requirePermission("inventory:read"), c.getStockLevels);
router.post("/items/:id/adjust", requirePermission("inventory:adjust"), validateBody(adjustStockSchema), c.adjustStock);
router.get("/items/:id/movements", requirePermission("inventory:read"), c.listMovements);

// Warehouses
router.get("/warehouses", requirePermission("inventory:read"), c.listWarehouses);
router.get("/warehouses/:whId", requirePermission("inventory:read"), c.getWarehouse);
router.post("/warehouses", requirePermission("inventory:write"), validateBody(createWarehouseSchema), c.createWarehouse);
router.patch("/warehouses/:whId", requirePermission("inventory:write"), validateBody(updateWarehouseSchema), c.updateWarehouse);

// Price lists
router.get("/price-lists", requirePermission("inventory:read"), c.listPriceLists);
router.get("/price-lists/:plId", requirePermission("inventory:read"), c.getPriceList);
router.post("/price-lists", requirePermission("inventory:write"), validateBody(createPriceListSchema), c.createPriceList);
router.patch("/price-lists/:plId", requirePermission("inventory:write"), validateBody(updatePriceListSchema), c.updatePriceList);
router.delete("/price-lists/:plId", requirePermission("inventory:delete"), c.deletePriceList);

// Valuation report
router.get("/valuation", requirePermission("inventory:read"), c.getValuation);

export default router;
