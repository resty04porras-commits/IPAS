import { db } from "../postgres.js";
import type { InventoryItem, CreateInventoryItemDTO } from "../../inventory.js";

function mapInventoryItem(row: any): InventoryItem {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description ?? undefined,
    category: row.category,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unitPrice),
    location: row.location ?? undefined,
    supplier: row.supplier ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const INVENTORY_SELECT = `
  SELECT
    id,
    sku,
    name,
    description,
    category,
    quantity,
    unit_price AS "unitPrice",
    location,
    supplier,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM inventory_items
`;

export async function getInventoryItems(): Promise<InventoryItem[]> {
  const result = await db.query(
    `${INVENTORY_SELECT} ORDER BY created_at DESC`
  );

  return result.rows.map(mapInventoryItem);
}

export async function findInventoryItemById(
  id: string,
): Promise<InventoryItem | null> {
  const result = await db.query(
    `${INVENTORY_SELECT} WHERE id = $1::uuid LIMIT 1`,
    [id],
  );

  return result.rows[0] ? mapInventoryItem(result.rows[0]) : null;
}

export async function createInventoryItem(
  input: CreateInventoryItemDTO,
): Promise<InventoryItem> {
  const result = await db.query(
    `
      INSERT INTO inventory_items (
        sku,
        name,
        description,
        category,
        quantity,
        unit_price,
        location,
        supplier
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `,
    [
      input.sku.trim(),
      input.name.trim(),
      input.description ?? null,
      input.category.trim(),
      input.quantity,
      input.unitPrice,
      input.location ?? null,
      input.supplier ?? null,
    ],
  );

  const item = await findInventoryItemById(result.rows[0].id);

  if (!item) {
    throw new Error("Created inventory item could not be reloaded.");
  }

  return item;
}

export async function updateInventoryItem(
  id: string,
  input: Partial<CreateInventoryItemDTO>,
): Promise<InventoryItem | null> {
  const existing = await findInventoryItemById(id);

  if (!existing) {
    return null;
  }

  const result = await db.query(
    `
      UPDATE inventory_items
      SET
        sku = $2,
        name = $3,
        description = $4,
        category = $5,
        quantity = $6,
        unit_price = $7,
        location = $8,
        supplier = $9,
        updated_at = NOW()
      WHERE id = $1::uuid
      RETURNING id
    `,
    [
      id,
      input.sku?.trim() ?? existing.sku,
      input.name?.trim() ?? existing.name,
      input.description !== undefined
        ? input.description
        : existing.description ?? null,
      input.category?.trim() ?? existing.category,
      input.quantity ?? existing.quantity,
      input.unitPrice ?? existing.unitPrice,
      input.location !== undefined
        ? input.location
        : existing.location ?? null,
      input.supplier !== undefined
        ? input.supplier
        : existing.supplier ?? null,
    ],
  );

  if (!result.rows[0]) {
    return null;
  }

  return findInventoryItemById(result.rows[0].id);
}

export async function deleteInventoryItem(id: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM inventory_items WHERE id = $1::uuid`,
    [id],
  );

  return (result.rowCount ?? 0) > 0;
}