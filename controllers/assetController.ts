import type { Request, Response } from "express";
import type { CreateInventoryItemDTO } from "../inventory.js";
import {
  createInventoryItem as createInventoryItemInRepository,
  deleteInventoryItem as deleteInventoryItemFromRepository,
  findInventoryItemById,
  getInventoryItems,
  updateInventoryItem as updateInventoryItemInRepository,
} from "../database/repositories/assetRepository.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

export async function getInventory(_req: Request, res: Response) {
  try {
    const inventory = await getInventoryItems();
    return res.json(inventory);
  } catch (error) {
    console.error("Inventory get all error:", error);
    return res.status(500).json({ error: "Unable to load inventory." });
  }
}

export async function getInventoryItem(req: Request, res: Response) {
  try {
     if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: "Inventory item not found" });
    }
    const item = await findInventoryItemById(req.params.id);

    if (!item) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    return res.json(item);
  } catch (error) {
    console.error("Inventory get item error:", error);
    return res.status(500).json({ error: "Unable to load inventory item." });
  }
}

export async function createInventoryItem(req: Request, res: Response) {
  try {
    const dto = req.body as CreateInventoryItemDTO;

    if (!dto?.sku?.trim()) {
      return res.status(400).json({ error: "SKU is required." });
    }

    if (!dto?.name?.trim()) {
      return res.status(400).json({ error: "Name is required." });
    }

    if (!dto?.category?.trim()) {
      return res.status(400).json({ error: "Category is required." });
    }

    const newItem = await createInventoryItemInRepository(dto);

    return res.status(201).json(newItem);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: "SKU already exists." });
    }

    console.error("Inventory create error:", error);
    return res.status(500).json({ error: "Unable to create inventory item." });
  }
}

export async function updateInventoryItem(req: Request, res: Response) {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    const updatedItem = await updateInventoryItemInRepository(
      req.params.id,
      req.body,
    );

    if (!updatedItem) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    return res.json(updatedItem);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: "SKU already exists." });
    }

    console.error("Inventory update error:", error);
    return res.status(500).json({ error: "Unable to update inventory item." });
  }
}

export async function deleteInventoryItem(req: Request, res: Response) {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(404).json({ error: "Inventory item not found" });
    }
    
    const deleted = await deleteInventoryItemFromRepository(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    return res.json({
      success: true,
      message: "Inventory item deleted",
      id: req.params.id,
    });
  } catch (error) {
    console.error("Inventory delete error:", error);
    return res.status(500).json({ error: "Unable to delete inventory item." });
  }
}