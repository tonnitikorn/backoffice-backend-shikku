import { Types } from 'mongoose';
import { Product, priceForPower } from '../models/Product';
import { ProductVariant } from '../models/ProductVariant';
import { ProductSku } from '../models/ProductSku';
import { SkuGenerationBatch, IPowerRange } from '../models/SkuGenerationBatch';
import { getSetting } from './settingsService';
import { SETTING_KEYS } from '../models/Setting';
import { recordAudit } from './auditService';
import { ApiError } from '../utils/ApiError';

/**
 * Encodes a diopter value into the `{power}` token of the SKU code format,
 * e.g. -3.25 -> "M0325", +0.00 -> "0000", +2.00 -> "P0200" (spec B5 example
 * "ACM-M0325"). Round to the nearest 0.25 to keep codes canonical.
 */
export function encodePower(power: number): string {
  const rounded = Math.round(power * 4) / 4;
  const magnitude = Math.round(Math.abs(rounded) * 100)
    .toString()
    .padStart(4, '0');
  if (rounded < 0) return `M${magnitude}`;
  if (rounded > 0) return `P${magnitude}`;
  return magnitude;
}

export function expandRanges(ranges: IPowerRange[]): number[] {
  const values = new Set<number>();
  for (const { from, to, step } of ranges) {
    if (step <= 0) throw ApiError.badRequest('Range step must be positive');
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    // Work in integer hundredths to avoid float drift (e.g. 0.1 + 0.2).
    const loInt = Math.round(lo * 100);
    const hiInt = Math.round(hi * 100);
    const stepInt = Math.round(step * 100);
    for (let v = loInt; v <= hiInt; v += stepInt) {
      values.add(v / 100);
    }
  }
  return Array.from(values).sort((a, b) => a - b);
}

/**
 * Derives a short, readable color code from a color name when none is given:
 * multi-word names use initials ("Light Brown" -> "LB"), single words their
 * first three letters ("Gray" -> "GRA"). Non-Latin names fall back to "C1".."Cn".
 */
export function deriveColorCode(colorName: string, index = 0): string {
  const words = colorName.trim().toUpperCase().split(/\s+/).map((w) => w.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  if (words.length === 0) return `C${index + 1}`;
  if (words.length === 1) return words[0].slice(0, 3);
  return words.map((w) => w[0]).join('').slice(0, 4);
}

/**
 * `{color}` is optional in the configured format; when it's absent but the
 * SKU belongs to a color variant, the color code is appended to the model
 * code so different colors of the same power never collide.
 */
export function buildSkuCode(format: string, shortCode: string, power: number | undefined, colorCode?: string): string {
  let code = format;
  if (colorCode) {
    code = code.includes('{color}') ? code.replace('{color}', colorCode) : code.replace('{modelCode}', `{modelCode}-${colorCode}`);
  } else {
    code = code.replace(/-?\{color\}/, '');
  }
  code = code.replace('{modelCode}', shortCode);
  code = power === undefined ? code.replace(/-?\{power\}/, '') : code.replace('{power}', encodePower(power));
  return code.toUpperCase();
}

export interface GenerateSkuInput {
  productId: string;
  variantId?: string;
  ranges: IPowerRange[];
  codeFormat?: string;
  createdBy: string;
}

export interface SkuPreviewItem {
  power: number;
  skuCode: string;
  isDuplicate: boolean;
}

export async function previewSkuGeneration(input: GenerateSkuInput): Promise<{
  items: SkuPreviewItem[];
  totalRequested: number;
  totalToCreate: number;
  totalDuplicates: number;
  cap: number;
  exceedsCap: boolean;
}> {
  const product = await Product.findById(input.productId);
  if (!product) throw ApiError.notFound('Product not found');
  let colorCode: string | undefined;
  if (input.variantId) {
    const variant = await ProductVariant.findById(input.variantId);
    if (!variant) throw ApiError.notFound('Product variant not found');
    colorCode = variant.colorCode;
  }

  const cap = await getSetting<number>(SETTING_KEYS.skuGenerationCap);
  const format = input.codeFormat ?? (await getSetting<string>(SETTING_KEYS.skuCodeFormat));
  const powers = expandRanges(input.ranges);

  const candidateCodes = powers.map((p) => buildSkuCode(format, product.shortCode, p, colorCode));
  const existing = await ProductSku.find({ skuCode: { $in: candidateCodes } }).select('skuCode');
  const existingSet = new Set(existing.map((s) => s.skuCode));

  const items: SkuPreviewItem[] = powers.map((power, i) => ({
    power,
    skuCode: candidateCodes[i],
    isDuplicate: existingSet.has(candidateCodes[i]),
  }));

  const totalToCreate = items.filter((i) => !i.isDuplicate).length;

  return {
    items,
    totalRequested: items.length,
    totalToCreate,
    totalDuplicates: items.length - totalToCreate,
    cap,
    exceedsCap: totalToCreate > cap,
  };
}

export async function generateSkus(input: GenerateSkuInput) {
  const product = await Product.findById(input.productId);
  if (!product) throw ApiError.notFound('Product not found');

  const preview = await previewSkuGeneration(input);
  if (preview.exceedsCap) {
    throw ApiError.badRequest(
      `Generating ${preview.totalToCreate} new SKUs exceeds the per-run cap of ${preview.cap}`,
    );
  }
  if (preview.totalToCreate === 0) {
    throw ApiError.badRequest('No new SKUs to create — all requested powers already exist');
  }

  const format = input.codeFormat ?? (await getSetting<string>(SETTING_KEYS.skuCodeFormat));

  const batch = await SkuGenerationBatch.create({
    productId: product._id,
    variantId: input.variantId,
    ranges: input.ranges,
    codeFormatUsed: format,
    requestedCount: preview.totalRequested,
    createdCount: preview.totalToCreate,
    skippedDuplicateCount: preview.totalDuplicates,
    createdBy: input.createdBy,
  });

  const toCreate = preview.items.filter((i) => !i.isDuplicate);
  const docs = toCreate.map((item) => ({
    productId: product._id,
    variantId: input.variantId,
    skuCode: item.skuCode,
    barcode: item.skuCode, // internal barcode = SKU code when the product has no real barcode (spec B5)
    power: item.power,
    priceRegular: priceForPower(product, item.power),
    cost: product.defaultCost,
    minStockLevel: product.defaultMinStockLevel,
    unitOfMeasure: product.unitOfMeasure,
    generationBatchId: batch._id,
  }));

  const created = await ProductSku.insertMany(docs, { ordered: false });

  await recordAudit({
    userId: input.createdBy,
    action: 'sku_generation.create',
    entityType: 'SkuGenerationBatch',
    entityId: batch._id.toString(),
    after: {
      productId: product._id.toString(),
      ranges: input.ranges,
      createdCount: created.length,
      skippedDuplicateCount: preview.totalDuplicates,
    },
  });

  return { batch, createdSkus: created };
}
