import { Types } from 'mongoose';
import { ProductSku, IProductSku } from '../models/ProductSku';
import { Product } from '../models/Product';
import { Inventory } from '../models/Inventory';
import { getSetting } from './settingsService';
import { SETTING_KEYS } from '../models/Setting';

export function sanitizeSku(sku: IProductSku & { toObject?: () => IProductSku }, canViewCost: boolean) {
  const obj = sku.toObject ? sku.toObject() : sku;
  if (!canViewCost) {
    const { cost: _cost, ...rest } = obj;
    return rest;
  }
  return obj;
}

export interface SkuSearchResult {
  sku: IProductSku;
  qtyOnHand: number;
}

/**
 * Search SKUs by name/brand/model/barcode/power for the POS and stock
 * screens (spec item 6: "ค้นหาได้ด้วยชื่อสินค้า Barcode SKU Brand รุ่น
 * หรือค่าสายตา"), joined with the requested branch's on-hand quantity.
 */
export async function searchSkus(params: {
  q?: string;
  branchId: string;
  activeOnly?: boolean;
}): Promise<SkuSearchResult[]> {
  const { q, branchId, activeOnly = true } = params;

  const baseFilter: Record<string, unknown> = activeOnly ? { active: true } : {};

  let skus: IProductSku[];
  if (q) {
    const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const orConditions: Record<string, unknown>[] = [
      { skuCode: { $regex: pattern, $options: 'i' } },
      { barcode: { $regex: pattern, $options: 'i' } },
    ];

    const maybePower = Number(q);
    if (!Number.isNaN(maybePower) && q.trim() !== '') {
      orConditions.push({ power: maybePower });
    }

    const matchingProductIds = await Product.find({
      $or: [
        { name: { $regex: pattern, $options: 'i' } },
        { seriesName: { $regex: pattern, $options: 'i' } },
        { shortCode: { $regex: pattern, $options: 'i' } },
      ],
    }).distinct('_id');
    if (matchingProductIds.length > 0) {
      orConditions.push({ productId: { $in: matchingProductIds } });
    }

    skus = await ProductSku.find({ ...baseFilter, $or: orConditions })
      .populate('productId')
      .limit(100);
  } else {
    skus = await ProductSku.find(baseFilter).populate('productId').limit(100);
  }

  const skuIds = skus.map((s) => s._id);
  const inventories = await Inventory.find({ branchId, skuId: { $in: skuIds } });
  const qtyMap = new Map(inventories.map((i) => [i.skuId.toString(), i.qtyOnHand]));

  return skus.map((sku) => ({ sku, qtyOnHand: qtyMap.get(sku._id.toString()) ?? 0 }));
}

export async function getLowStockSkus(branchId?: string) {
  const defaultThreshold = await getSetting<number>(SETTING_KEYS.lowStockDefaultThreshold);

  const match: Record<string, unknown> = {};
  if (branchId) match.branchId = new Types.ObjectId(branchId);

  const inventories = await Inventory.find(match).populate('skuId');
  const results = [];
  for (const inv of inventories) {
    const sku = inv.skuId as unknown as IProductSku;
    if (!sku || !sku.active) continue;
    const threshold = sku.minStockLevel || defaultThreshold;
    if (inv.qtyOnHand <= threshold) {
      results.push({ branchId: inv.branchId, sku, qtyOnHand: inv.qtyOnHand, threshold });
    }
  }
  return results;
}
