import { Types } from 'mongoose';
import { Product } from '../models/Product';
import { ProductVariant } from '../models/ProductVariant';
import { ProductSku } from '../models/ProductSku';
import { Brand } from '../models/Brand';
import { Category } from '../models/Category';
import { SETTING_KEYS } from '../models/Setting';
import { ProductType, UnitOfMeasure } from '../config/constants';
import { withTransaction } from '../config/db';
import { getSetting } from './settingsService';
import { recordAudit } from './auditService';
import { buildSkuCode, deriveColorCode, expandRanges } from './skuGenerationService';
import { ApiError } from '../utils/ApiError';

/** Max SKUs one import may create — large enough for a whole catalogue, small enough for one transaction. */
export const IMPORT_SKU_LIMIT = 5000;

/** One spreadsheet row, already mapped to our fields by the client. All values are raw cell text. */
export interface ImportRowInput {
  row: number; // spreadsheet row number, for error messages
  name?: string;
  shortCode?: string;
  seriesName?: string;
  type?: string;
  brand?: string;
  category?: string;
  unit?: string;
  color?: string;
  colorCode?: string;
  powers?: string;
  price?: string;
  powerPrice?: string; // price for non-zero powers, when it differs from plano
  cost?: string;
  minStock?: string;
  dia?: string;
  bc?: string;
  wearDays?: string;
  barcode?: string;
}

export interface ImportRowError {
  row: number;
  message: string;
}

const UNIT_ALIASES: Record<string, UnitOfMeasure> = {
  คู่: 'pair', pair: 'pair', pairs: 'pair',
  ชิ้น: 'piece', อัน: 'piece', piece: 'piece', pcs: 'piece', pc: 'piece',
  กล่อง: 'box', box: 'box',
  ขวด: 'bottle', bottle: 'bottle',
  ชุด: 'set', set: 'set',
};

function clean(v: string | undefined): string {
  const s = (v ?? '').toString().trim();
  return s === '-' || s === '–' ? '' : s;
}

function parseNumber(v: string | undefined): number | undefined | null {
  const s = clean(v).replace(/[฿,\s]|บาท/g, '');
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : null; // null = present but invalid
}

function parseType(v: string | undefined): ProductType | null {
  const s = clean(v).toLowerCase();
  if (s === '' || s.includes('คอนแทค') || s.includes('เลนส์') || s.includes('lens')) return 'contact_lens';
  if (s.includes('ทั่วไป') || s.includes('อื่น') || s === 'other' || s.includes('อุปกรณ์') || s.includes('น้ำยา')) return 'other';
  return null;
}

const NUM = '([+-]?\\d+(?:\\.\\d+)?)';
const RANGE_RE = new RegExp(`^${NUM}\\s*(?:~|ถึง|to|\\.\\.|:)\\s*${NUM}(?:\\s*(?:@|ขั้นละ|ขั้น|step|/|:)\\s*(\\d+(?:\\.\\d+)?))?$`, 'i');

/**
 * Parses a power cell: a single value ("-1.25"), a list ("0, -0.50, -1.00"),
 * a range ("0 ถึง -6 ขั้นละ 0.25", "0~-6@0.25", "0:-6:0.25"; default step
 * 0.25), or any comma-separated mix. Returns null when unparseable.
 */
export function parsePowers(v: string | undefined): number[] | undefined | null {
  const s = clean(v).replace(/[()]/g, '');
  if (s === '') return undefined;
  const values = new Set<number>();
  for (const part of s.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(RANGE_RE);
    if (m) {
      const step = m[3] ? Number(m[3]) : 0.25;
      if (!(step > 0)) return null;
      expandRanges([{ from: Number(m[1]), to: Number(m[2]), step }]).forEach((p) => values.add(p));
      continue;
    }
    const n = Number(part.replace(/\s/g, ''));
    if (!Number.isFinite(n)) return null;
    values.add(Math.round(n * 100) / 100);
  }
  return Array.from(values).sort((a, b) => b - a);
}

/** "Mini Olivia 850" -> "MO850" (mirrors the frontend suggestion). */
export function suggestShortCode(name: string): string {
  const words = name.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const code = words
    .map((w) => (/^\d+$/.test(w) ? w : w.replace(/[^A-Z0-9]/g, '').charAt(0)))
    .join('')
    .slice(0, 10);
  return code || 'P';
}

interface PlannedSku {
  row: number;
  colorKey: string | null;
  power?: number;
  skuCode: string;
  barcode: string;
  price?: number;
  cost?: number;
  minStock?: number;
}

interface PlannedProduct {
  key: string;
  existingId?: Types.ObjectId;
  firstRow: number;
  name: string;
  shortCode: string;
  autoCode: boolean; // shortCode was derived from the name, so we may change it to avoid clashes
  seriesName?: string;
  type: ProductType;
  unit: UnitOfMeasure;
  brandName?: string;
  categoryName?: string;
  dia?: number;
  bc?: number;
  wearDays?: number;
  defaultPrice: number;
  defaultPowerPrice?: number;
  defaultCost: number;
  defaultMinStock: number;
  colors: Map<string, { name: string; code: string; existingId?: Types.ObjectId }>;
  skus: PlannedSku[];
  skipped: number;
}

export interface ImportPlan {
  products: PlannedProduct[];
  errors: ImportRowError[];
  newBrands: string[];
  newCategories: string[];
  newSkuCount: number;
  skippedCount: number;
}

async function buildPlan(rows: ImportRowInput[]): Promise<ImportPlan> {
  const errors: ImportRowError[] = [];
  const format = await getSetting<string>(SETTING_KEYS.skuCodeFormat);
  const groups = new Map<string, PlannedProduct>();
  let lastName = '';

  for (const r of rows) {
    const rowErr = (message: string) => errors.push({ row: r.row, message });

    // A blank (or "-") name continues the product above — how grouped sheets are usually laid out.
    const name = clean(r.name) || lastName;
    if (!name) {
      rowErr('ไม่มีชื่อสินค้า');
      continue;
    }
    lastName = name;
    const key = name.toLowerCase();

    const price = parseNumber(r.price);
    const powerPrice = parseNumber(r.powerPrice);
    const cost = parseNumber(r.cost);
    const minStock = parseNumber(r.minStock);
    const dia = parseNumber(r.dia);
    const bc = parseNumber(r.bc);
    const wearDays = parseNumber(r.wearDays);
    const powers = parsePowers(r.powers);
    const type = parseType(r.type);
    const unitText = clean(r.unit).toLowerCase();
    const unit = unitText ? UNIT_ALIASES[unitText] : undefined;

    if (price === null) rowErr(`ราคาไม่ถูกต้อง: "${r.price}"`);
    if (powerPrice === null) rowErr(`ราคาค่าสายตาไม่ถูกต้อง: "${r.powerPrice}"`);
    if (cost === null) rowErr(`ต้นทุนไม่ถูกต้อง: "${r.cost}"`);
    if (minStock === null) rowErr(`สต๊อกขั้นต่ำไม่ถูกต้อง: "${r.minStock}"`);
    if (dia === null || bc === null || wearDays === null) rowErr('DIA / BC / ระยะใส่ ต้องเป็นตัวเลข');
    if (powers === null) rowErr(`ค่าสายตาอ่านไม่ได้: "${r.powers}" (ตัวอย่าง: -1.25 หรือ 0,-0.5 หรือ 0 ถึง -6 ขั้นละ 0.25)`);
    if (type === null) rowErr(`ประเภทสินค้าไม่รู้จัก: "${r.type}" (ใช้ คอนแทคเลนส์ หรือ สินค้าทั่วไป)`);
    if (unitText && !unit) rowErr(`หน่วยนับไม่รู้จัก: "${r.unit}" (ใช้ คู่ ชิ้น กล่อง ขวด ชุด)`);
    if ([price, powerPrice, cost, minStock, dia, bc, wearDays, powers].includes(null) || type === null || (unitText && !unit)) continue;

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        firstRow: r.row,
        name,
        shortCode: clean(r.shortCode).toUpperCase().replace(/\s+/g, '') || suggestShortCode(name),
        autoCode: !clean(r.shortCode),
        seriesName: clean(r.seriesName) || undefined,
        type: type ?? 'contact_lens',
        unit: unit ?? (type === 'other' ? 'piece' : 'pair'),
        brandName: clean(r.brand) || undefined,
        categoryName: clean(r.category) || undefined,
        dia: dia ?? undefined,
        bc: bc ?? undefined,
        wearDays: wearDays ?? undefined,
        defaultPrice: Math.round((price ?? 0) * 100),
        defaultPowerPrice: powerPrice == null ? undefined : Math.round(powerPrice * 100),
        defaultCost: Math.round((cost ?? 0) * 100),
        defaultMinStock: minStock ?? 0,
        colors: new Map(),
        skus: [],
        skipped: 0,
      };
      groups.set(key, group);
    }

    const colorName = clean(r.color);
    let colorKey: string | null = null;
    if (colorName) {
      colorKey = colorName.toLowerCase();
      if (!group.colors.has(colorKey)) {
        group.colors.set(colorKey, { name: colorName, code: clean(r.colorCode).toUpperCase().replace(/[^A-Z0-9]/g, '') });
      }
    }

    const rowPowers: (number | undefined)[] = powers && powers.length > 0 ? powers : [undefined];
    const barcode = clean(r.barcode);
    if (barcode && rowPowers.length > 1) rowErr('ใส่ Barcode ได้เฉพาะแถวที่มีค่าสายตาเดียว');
    for (const power of rowPowers) {
      group.skus.push({
        row: r.row,
        colorKey,
        power,
        skuCode: '', // filled once color codes are final
        barcode: rowPowers.length === 1 ? barcode : '',
        // Same rule as the add form: non-zero powers use the power price when one is given.
        price: power && powerPrice != null ? Math.round(powerPrice * 100) : price == null ? undefined : Math.round(price * 100),
        cost: cost == null ? undefined : Math.round(cost * 100),
        minStock: minStock ?? undefined,
      });
    }
  }

  // Match existing products by exact (case-insensitive) name so re-imports extend them instead of duplicating.
  const products = Array.from(groups.values());
  const existingProducts = await Product.find({
    name: { $in: products.map((p) => new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) },
  });
  for (const p of products) {
    const existing = existingProducts.find((e) => e.name.toLowerCase() === p.key);
    if (!existing) continue;
    p.existingId = existing._id;
    p.shortCode = existing.shortCode;
    p.type = existing.type;
    p.unit = existing.unitOfMeasure;
    const variants = await ProductVariant.find({ productId: existing._id });
    for (const v of variants) {
      const k = v.colorName?.toLowerCase();
      if (k && p.colors.has(k)) {
        p.colors.set(k, { name: v.colorName!, code: v.colorCode ?? '', existingId: v._id });
      }
    }
  }

  // Auto-derived short codes of new products must not clash with each other or with existing products.
  const takenCodes = new Set<string>(
    (await Product.find({ shortCode: { $in: products.map((p) => p.shortCode) } }).select('shortCode _id'))
      .filter((e) => !products.some((p) => p.existingId?.equals(e._id)))
      .map((e) => e.shortCode),
  );
  for (const p of products) {
    if (p.existingId) continue;
    if (p.autoCode) {
      const base = p.shortCode;
      for (let n = 2; takenCodes.has(p.shortCode); n += 1) p.shortCode = `${base}${n}`;
    }
    takenCodes.add(p.shortCode);
  }

  // Final color codes: keep given/existing ones, derive the rest, and make them unique per product.
  for (const p of products) {
    const used = new Set(Array.from(p.colors.values()).map((c) => c.code).filter(Boolean));
    let i = 0;
    for (const c of p.colors.values()) {
      if (!c.code && !c.existingId) {
        let code = deriveColorCode(c.name, i);
        for (let n = 2; used.has(code); n += 1) code = `${deriveColorCode(c.name, i).slice(0, 4)}${n}`;
        c.code = code;
        used.add(code);
      }
      i += 1;
    }
    for (const s of p.skus) {
      const color = s.colorKey ? p.colors.get(s.colorKey) : undefined;
      s.skuCode = buildSkuCode(format, p.shortCode, s.power, color?.code || undefined);
      s.barcode = s.barcode || s.skuCode;
    }
  }

  // Duplicate detection: inside the file, and against the database.
  const seen = new Map<string, number>();
  for (const p of products) {
    for (const s of p.skus) {
      const prev = seen.get(s.skuCode);
      if (prev !== undefined) errors.push({ row: s.row, message: `SKU ${s.skuCode} ซ้ำกับแถว ${prev} (สี/ค่าสายตาซ้ำ หรือรหัสย่อชนกัน)` });
      else seen.set(s.skuCode, s.row);
    }
  }
  const allCodes = products.flatMap((p) => p.skus.map((s) => s.skuCode));
  const allBarcodes = products.flatMap((p) => p.skus.map((s) => s.barcode));
  const existingSkus = await ProductSku.find({ $or: [{ skuCode: { $in: allCodes } }, { barcode: { $in: allBarcodes } }] }).select('skuCode barcode productId');
  const byCode = new Map(existingSkus.map((s) => [s.skuCode, s]));
  const byBarcode = new Map(existingSkus.map((s) => [s.barcode, s]));
  for (const p of products) {
    p.skus = p.skus.filter((s) => {
      const hit = byCode.get(s.skuCode);
      if (hit && p.existingId && hit.productId.equals(p.existingId)) {
        p.skipped += 1; // already imported earlier — skip quietly
        return false;
      }
      if (hit) {
        errors.push({ row: s.row, message: `SKU ${s.skuCode} มีอยู่แล้วในสินค้าอื่น — เปลี่ยนรหัสย่อ` });
        return false;
      }
      const bcHit = byBarcode.get(s.barcode);
      if (bcHit && !(p.existingId && bcHit.productId.equals(p.existingId))) {
        errors.push({ row: s.row, message: `Barcode ${s.barcode} ถูกใช้แล้ว` });
        return false;
      }
      return true;
    });
  }

  const brandNames = Array.from(new Set(products.filter((p) => !p.existingId && p.brandName).map((p) => p.brandName!)));
  const categoryNames = Array.from(new Set(products.filter((p) => !p.existingId && p.categoryName).map((p) => p.categoryName!)));
  const existingBrands = await Brand.find().select('name');
  const existingCategories = await Category.find().select('name');
  const hasName = (list: { name: string }[], n: string) => list.some((x) => x.name.toLowerCase() === n.toLowerCase());

  const newSkuCount = products.reduce((s, p) => s + p.skus.length, 0);
  if (newSkuCount > IMPORT_SKU_LIMIT) {
    errors.push({ row: 0, message: `จะสร้าง ${newSkuCount} SKU เกินขีดจำกัด ${IMPORT_SKU_LIMIT} ต่อการนำเข้า — แบ่งไฟล์เป็นหลายส่วน` });
  }

  return {
    products,
    errors: errors.sort((a, b) => a.row - b.row),
    newBrands: brandNames.filter((n) => !hasName(existingBrands, n)),
    newCategories: categoryNames.filter((n) => !hasName(existingCategories, n)),
    newSkuCount,
    skippedCount: products.reduce((s, p) => s + p.skipped, 0),
  };
}

function summarize(plan: ImportPlan) {
  return {
    errors: plan.errors,
    newBrands: plan.newBrands,
    newCategories: plan.newCategories,
    newSkuCount: plan.newSkuCount,
    skippedCount: plan.skippedCount,
    newProductCount: plan.products.filter((p) => !p.existingId).length,
    updatedProductCount: plan.products.filter((p) => p.existingId && p.skus.length > 0).length,
    products: plan.products.map((p) => ({
      row: p.firstRow,
      name: p.name,
      shortCode: p.shortCode,
      isNew: !p.existingId,
      colors: Array.from(p.colors.values()).map((c) => ({ name: c.name, code: c.code, isNew: !c.existingId })),
      newSkuCount: p.skus.length,
      skipped: p.skipped,
      sampleSku: p.skus[0]?.skuCode,
      price: p.skus[0]?.price ?? p.defaultPrice,
    })),
  };
}

export async function previewImport(rows: ImportRowInput[]) {
  return summarize(await buildPlan(rows));
}

export async function importProducts(rows: ImportRowInput[], createdBy: string) {
  const plan = await buildPlan(rows);
  if (plan.errors.length > 0) {
    throw ApiError.badRequest(`พบข้อผิดพลาด ${plan.errors.length} รายการ — แก้ไฟล์แล้วลองใหม่`, { errors: plan.errors });
  }
  if (plan.newSkuCount === 0) throw ApiError.badRequest('ไม่มี SKU ใหม่ให้นำเข้า — ทุกรายการมีอยู่แล้ว');

  return withTransaction(async (session) => {
    const brandIds = new Map<string, Types.ObjectId>();
    const categoryIds = new Map<string, Types.ObjectId>();
    for (const b of await Brand.find().session(session)) brandIds.set(b.name.toLowerCase(), b._id);
    for (const c of await Category.find().session(session)) categoryIds.set(c.name.toLowerCase(), c._id);

    for (const name of plan.newBrands) {
      const [b] = await Brand.create([{ name }], { session });
      brandIds.set(name.toLowerCase(), b._id);
    }
    for (const name of plan.newCategories) {
      const type = plan.products.find((p) => p.categoryName?.toLowerCase() === name.toLowerCase())?.type ?? 'contact_lens';
      const [c] = await Category.create([{ name, appliesTo: type }], { session });
      categoryIds.set(name.toLowerCase(), c._id);
    }

    let createdProducts = 0;
    for (const p of plan.products) {
      if (p.skus.length === 0 && p.existingId) continue;

      let productId = p.existingId;
      if (!productId) {
        const [created] = await Product.create(
          [
            {
              name: p.name,
              shortCode: p.shortCode,
              seriesName: p.seriesName,
              type: p.type,
              unitOfMeasure: p.unit,
              brandId: p.brandName ? brandIds.get(p.brandName.toLowerCase()) : undefined,
              categoryId: p.categoryName ? categoryIds.get(p.categoryName.toLowerCase()) : undefined,
              dia: p.dia,
              bc: p.bc,
              wearDurationDays: p.wearDays,
              defaultPriceRegular: p.defaultPrice,
              defaultPowerPriceRegular: p.defaultPowerPrice,
              defaultCost: p.defaultCost,
              defaultMinStockLevel: p.defaultMinStock,
            },
          ],
          { session },
        );
        productId = created._id;
        createdProducts += 1;
      }

      const newColors = Array.from(p.colors.values()).filter((c) => !c.existingId);
      if (newColors.length > 0) {
        const variants = await ProductVariant.insertMany(
          newColors.map((c) => ({ productId, colorName: c.name, colorCode: c.code })),
          { session },
        );
        newColors.forEach((c, i) => (c.existingId = variants[i]._id));
      }

      await ProductSku.insertMany(
        p.skus.map((s) => ({
          productId,
          variantId: s.colorKey ? p.colors.get(s.colorKey)!.existingId : undefined,
          skuCode: s.skuCode,
          barcode: s.barcode,
          power: s.power,
          priceRegular: s.price ?? (s.power && p.defaultPowerPrice != null ? p.defaultPowerPrice : p.defaultPrice),
          cost: s.cost ?? p.defaultCost,
          minStockLevel: s.minStock ?? p.defaultMinStock,
          unitOfMeasure: p.unit,
        })),
        { session },
      );
    }

    await recordAudit(
      {
        userId: createdBy,
        action: 'product.import',
        entityType: 'Product',
        after: { rowCount: rows.length, createdProducts, skuCount: plan.newSkuCount, skipped: plan.skippedCount },
      },
      session,
    );

    return { createdProducts, skuCount: plan.newSkuCount, skippedCount: plan.skippedCount };
  });
}
