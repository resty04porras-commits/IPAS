export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  description?: string;
  category: string;
  quantity: number;
  unitPrice: number;
  location?: string;
  supplier?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateInventoryItemDTO = Omit<InventoryItem, 'id' | 'createdAt' | 'updatedAt'>;