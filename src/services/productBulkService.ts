import { ClientSession, Types } from 'mongoose';
import { Product, IProduct, priceForPower } from '../models/Product';
import { ProductVariant } from '../models/ProductVariant';
import { ProductSku } from '../models/ProductSku';
import { IPowerRange } from '../models/SkuGenerationBatch';
import { SETTING_KEYS } from '../models/Setting';
import { ProductType, UnitOfMeasure } from '../config/constants';
import { withTransaction } from '../config/db';
import { getSetting } from './settingsService';
import { recordAudit } from './auditService';
import { buildSkuCode, deriveColorCode, expandRanges } from './skuGenerationService';
import { ApiError } from '../utils/ApiError';
import { Branch } from '../models/Branch';
import { moveStock } from './inventoryService';

/** Opening quantity for one model/color/power combination. */
export interface StockEntryInput {
  model: number; // index into models (always 0 when adding colors to one product)
  color: string | null; // color name, null when the product has no colors
  power: number | null;
  qty: number;
}

const stockKey = (model: number, color: string | null, power: number | null | undefined) =>
  `${model}|${(color ?? '').trim().toLowerCase()}|${power === null || power === undefined ? '' : power.toFixed(2)}`;

/**
 * Records opening stock for freshly created SKUs as ledger adjustments (never a
 * raw Inventory write) so the stock history explains where the quantity came from.
 */
async function applyOpeningStock(
  branchId: string | undefined,
  entries: StockEntryInput[] | undefined,
  skuIdByKey: Map<string, Types.ObjectId>,
  performedBy: string,
  session: ClientSession,
): Promise<number> {
  const positive = (entries ?? []).filter((e) => e.qty > 0);
  if (positive.length === 0) return 0;
  if (!branchId) throw ApiError.badRequest('ต้องเลือกสาขาเพื่อบันทึกจำนวนสต๊อกตั้งต้น');
  let total = 0;
  for (const e of positive) {
    const skuId = skuIdByKey.get(stockKey(e.model, e.color, e.power));
    if (!skuId) continue; // qty for a combination that isn't being created — ignore
    await moveStock({
      branchId,
      skuId,
      type: 'adjustment_increase',
      qty: e.qty,
      reason: 'ยอดตั้งต้นตอนเพิ่มสินค้า',
      refType: 'Adjustment',
      performedBy,
      session,
    });
    total += e.qty;
  }
  return total;
}

async function assertBranch(branchId: string | undefined, entries: StockEntryInput[] | undefined) {
  if (!(entries ?? []).some((e) => e.qty > 0)) return;
  if (!branchId) throw ApiError.badRequest('ต้องเลือกสาขาเพื่อบันทึกจำนวนสต๊อกตั้งต้น');
  if (!(await Branch.exists({ _id: branchId }))) throw ApiError.badRequest('ไม่พบสาขา');
}

function mergePowers(ranges: IPowerRange[], powers: number[] | undefined): number[] {
  const values = new Set<number>(ranges.length > 0 ? expandRanges(ranges) : []);
  for (const p of powers ?? []) values.add(Math.round(p * 100) / 100);
  return Array.from(values).sort((a, b) => b - a);
}

export interface ColorInput {
  name: string;
  code?: string;
}

export interface BulkProductInput {
  models: { name: string; shortCode: string; seriesName?: string }[];
  common: {
    type: ProductType;
    brandId?: string;
    categoryId?: string;
    unitOfMeasure?: UnitOfMeasure;
    defaultPriceRegular?: number;
    defaultPowerPriceRegular?: number;
    defaultCost?: number;
    defaultMinStockLevel?: number;
    dia?: number;
    bc?: number;
    wearDurationDays?: number;
    description?: string;
  };
  colors: ColorInput[];
  /** Power ranges and/or an explicit list; both empty = one SKU per color with no power. */
  ranges: IPowerRange[];
  powers?: number[];
  branchId?: string;
  stock?: StockEntryInput[];
  createdBy: string;
}

interface PlannedSku {
  modelIndex: number;
  colorIndex: number | null;
  power?: number;
  skuCode: string;
}

function normalizeColors(colors: ColorInput[]): { name: string; code: string }[] {
  const seenNames = new Set<string>();
  const seenCodes = new Set<string>();
  return colors
    .map((c) => ({ name: c.name.trim(), code: c.code?.trim() }))
    .filter((c) => c.name.length > 0)
    .map((c, i) => {
      const key = c.name.toLowerCase();
      if (seenNames.has(key)) throw ApiError.badRequest(`สีซ้ำกัน: ${c.name}`);
      seenNames.add(key);
      const code = (c.code || deriveColorCode(c.name, i)).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code) throw ApiError.badRequest(`รหัสสีของ ${c.name} ไม่ถูกต้อง`);
      if (seenCodes.has(code)) throw ApiError.badRequest(`รหัสสีซ้ำกัน: ${code} — กรุณาตั้งรหัสสีเองให้ไม่ซ้ำ`);
      seenCodes.add(code);
      return { name: c.name, code };
    });
}

async function planSkus(
  models: { shortCode: string }[],
  colors: { code: string }[],
  powerList: number[],
): Promise<{ planned: PlannedSku[]; duplicates: string[]; cap: number }> {
  const format = await getSetting<string>(SETTING_KEYS.skuCodeFormat);
  const cap = await getSetting<number>(SETTING_KEYS.skuGenerationCap);
  const powers: (number | undefined)[] = powerList.length > 0 ? powerList : [undefined];
  const colorSlots: (number | null)[] = colors.length > 0 ? colors.map((_, i) => i) : [null];

  const planned: PlannedSku[] = [];
  models.forEach((m, modelIndex) => {
    for (const colorIndex of colorSlots) {
      for (const power of powers) {
        const colorCode = colorIndex === null ? undefined : colors[colorIndex].code;
        planned.push({ modelIndex, colorIndex, power, skuCode: buildSkuCode(format, m.shortCode.toUpperCase(), power, colorCode) });
      }
    }
  });

  const codes = planned.map((p) => p.skuCode);
  const inBatch = codes.filter((c, i) => codes.indexOf(c) !== i);
  const existing = await ProductSku.find({ $or: [{ skuCode: { $in: codes } }, { barcode: { $in: codes } }] }).select('skuCode');
  const duplicates = Array.from(new Set([...inBatch, ...existing.map((s) => s.skuCode)]));
  return { planned, duplicates, cap };
}

export async function previewBulkProducts(input: Omit<BulkProductInput, 'createdBy'>) {
  const colors = normalizeColors(input.colors);
  const { planned, duplicates, cap } = await planSkus(input.models, colors, mergePowers(input.ranges, input.powers));
  return {
    productCount: input.models.length,
    colors,
    totalSkus: planned.length,
    duplicates,
    cap,
    exceedsCap: planned.length > cap,
    sample: planned.slice(0, 12).map((p) => p.skuCode),
  };
}

/**
 * Creates several models at once, each with the same colors (variants) and
 * the same power range — the common "one series, many colors × many powers"
 * case. Everything is written in one transaction so a failure (e.g. a
 * duplicate SKU code) leaves nothing half-created.
 */
export async function bulkCreateProducts(input: BulkProductInput) {
  if (input.models.length === 0) throw ApiError.badRequest('ต้องมีอย่างน้อย 1 รุ่น');
  const colors = normalizeColors(input.colors);
  const { planned, duplicates, cap } = await planSkus(input.models, colors, mergePowers(input.ranges, input.powers));
  await assertBranch(input.branchId, input.stock);
  if (duplicates.length > 0) {
    throw ApiError.conflict(`รหัส SKU ซ้ำกับที่มีอยู่: ${duplicates.slice(0, 5).join(', ')}${duplicates.length > 5 ? ' …' : ''}`, { duplicates });
  }
  if (planned.length > cap) {
    throw ApiError.badRequest(`จะสร้าง ${planned.length} SKU เกินเพดาน ${cap} ต่อครั้ง — แบ่งสร้างเป็นหลายรอบ หรือปรับเพดานในตั้งค่าระบบ`);
  }

  const { common } = input;
  return withTransaction(async (session) => {
    const products = await Product.insertMany(
      input.models.map((m) => ({
        ...common,
        name: m.name,
        shortCode: m.shortCode,
        seriesName: m.seriesName || undefined,
        brandId: common.brandId || undefined,
        categoryId: common.categoryId || undefined,
      })),
      { session },
    );

    const variantIds: Types.ObjectId[][] = [];
    for (const product of products) {
      const variants =
        colors.length > 0
          ? await ProductVariant.insertMany(
              colors.map((c) => ({ productId: product._id, colorName: c.name, colorCode: c.code })),
              { session },
            )
          : [];
      variantIds.push(variants.map((v) => v._id));
    }

    const skuDocs = planned.map((p) => {
      const product = products[p.modelIndex] as unknown as IProduct;
      return {
        productId: product._id,
        variantId: p.colorIndex === null ? undefined : variantIds[p.modelIndex][p.colorIndex],
        skuCode: p.skuCode,
        barcode: p.skuCode,
        power: p.power,
        priceRegular: priceForPower(product, p.power),
        cost: product.defaultCost,
        minStockLevel: product.defaultMinStockLevel,
        unitOfMeasure: product.unitOfMeasure,
      };
    });
    const createdSkus = await ProductSku.insertMany(skuDocs, { session });
    const skuIdByKey = new Map(
      planned.map((p, i) => [stockKey(p.modelIndex, p.colorIndex === null ? null : colors[p.colorIndex].name, p.power), createdSkus[i]._id]),
    );
    const stockQty = await applyOpeningStock(input.branchId, input.stock, skuIdByKey, input.createdBy, session);

    await recordAudit(
      {
        userId: input.createdBy,
        action: 'product.bulk_create',
        entityType: 'Product',
        after: {
          productIds: products.map((p) => p._id.toString()),
          colors: colors.map((c) => c.name),
          powers: mergePowers(input.ranges, input.powers),
          skuCount: skuDocs.length,
          openingStock: stockQty,
          branchId: input.branchId,
        },
      },
      session,
    );

    return { products, skuCount: skuDocs.length, stockQty };
  });
}

/** Adds several colors (with the given power range) to an existing product. */
export async function addColorsToProduct(
  productId: string,
  colorsInput: ColorInput[],
  ranges: IPowerRange[],
  createdBy: string,
  extra: { powers?: number[]; branchId?: string; stock?: StockEntryInput[] } = {},
) {
  const product = await Product.findById(productId);
  if (!product) throw ApiError.notFound('Product not found');

  const existingVariants = await ProductVariant.find({ productId: product._id });
  const existingNames = new Set(existingVariants.map((v) => v.colorName?.toLowerCase()));
  const existingCodes = new Set(existingVariants.map((v) => v.colorCode).filter(Boolean));
  const colors = normalizeColors(colorsInput);
  if (colors.length === 0) throw ApiError.badRequest('ต้องระบุอย่างน้อย 1 สี');
  for (const c of colors) {
    if (existingNames.has(c.name.toLowerCase())) throw ApiError.conflict(`สินค้านี้มีสี ${c.name} อยู่แล้ว`);
    if (existingCodes.has(c.code)) throw ApiError.conflict(`รหัสสี ${c.code} ถูกใช้แล้วในสินค้านี้`);
  }

  const { planned, duplicates, cap } = await planSkus([product], colors, mergePowers(ranges, extra.powers));
  await assertBranch(extra.branchId, extra.stock);
  if (duplicates.length > 0) throw ApiError.conflict(`รหัส SKU ซ้ำกับที่มีอยู่: ${duplicates.slice(0, 5).join(', ')}`, { duplicates });
  if (planned.length > cap) throw ApiError.badRequest(`จะสร้าง ${planned.length} SKU เกินเพดาน ${cap} ต่อครั้ง`);

  return withTransaction(async (session) => {
    const variants = await ProductVariant.insertMany(
      colors.map((c) => ({ productId: product._id, colorName: c.name, colorCode: c.code })),
      { session },
    );
    const createdSkus = await ProductSku.insertMany(
      planned.map((p) => ({
        productId: product._id,
        variantId: variants[p.colorIndex!]._id,
        skuCode: p.skuCode,
        barcode: p.skuCode,
        power: p.power,
        priceRegular: priceForPower(product, p.power),
        cost: product.defaultCost,
        minStockLevel: product.defaultMinStockLevel,
        unitOfMeasure: product.unitOfMeasure,
      })),
      { session },
    );
    await recordAudit(
      {
        userId: createdBy,
        action: 'product.add_colors',
        entityType: 'Product',
        entityId: product._id.toString(),
        after: { colors: colors.map((c) => c.name), powers: mergePowers(ranges, extra.powers), skuCount: planned.length },
      },
      session,
    );
    const skuIdByKey = new Map(planned.map((p, i) => [stockKey(0, colors[p.colorIndex!].name, p.power), createdSkus[i]._id]));
    const stockQty = await applyOpeningStock(extra.branchId, extra.stock, skuIdByKey, createdBy, session);
    return { variants, skuCount: planned.length, stockQty };
  });
}
