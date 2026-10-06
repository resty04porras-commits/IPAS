import type { Request, Response } from "express";
import type { InventoryItem, CreateInventoryItemDTO } from "../inventory.js";

/**
 * Temporary in-memory asset store.
 *
 * This intentionally preserves the current IPAS inventory behavior.
 * PostgreSQL persistence will be introduced during the database migration phase.
 */
const inventory: InventoryItem[] = [];

export function getInventory(_req: Request, res: Response) {
  return res.json(inventory);
}

export function getInventoryItem(req: Request, res: Response) {
  const item = inventory.find((entry) => entry.id === req.params.id);

  if (!item) {
    return res.status(404).json({ error: "Inventory item not found" });
  }

  return res.json(item);
}

export function createInventoryItem(req: Request, res: Response) {
  const dto = req.body as CreateInventoryItemDTO;

  const newItem: InventoryItem = {
    ...dto,
    id: Math.random().toString(36).substring(2, 9),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  inventory.push(newItem);

  return res.status(201).json(newItem);
}

export function updateInventoryItem(req: Request, res: Response) {
  const index = inventory.findIndex((entry) => entry.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: "Inventory item not found" });
  }

  const updatedItem: InventoryItem = {
    ...inventory[index],
    ...req.body,
    id: inventory[index].id,
    updatedAt: new Date(),
  };

  inventory[index] = updatedItem;

  return res.json(updatedItem);
}

export function deleteInventoryItem(req: Request, res: Response) {
  const index = inventory.findIndex((entry) => entry.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: "Inventory item not found" });
  }

  const [deleted] = inventory.splice(index, 1);

  return res.json({
    success: true,
    message: "Inventory item deleted",
    id: deleted.id,
  });
}
