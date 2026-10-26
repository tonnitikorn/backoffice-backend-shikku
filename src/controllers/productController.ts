import { Router } from 'express';
import { z } from 'zod';
import { Product, priceForPower } from '../models/Product';
import { ProductVariant } from '../models/ProductVariant';
import { ProductSku } from '../models/ProductSku';
import { PRODUCT_TYPES, UNIT_OF_MEASURE } from '../config/constants';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { resolvePermission } from '../services/permissionService';
import { sanitizeSku, searchSkus, getLowStockSkus } from '../services/productService';
import * as skuGen from '../services/skuGenerationService';
import * as productBulk from '../services/productBulkService';
import * as productImport from '../services/productImportService';
import { User } from '../models/User';
import { Inventory } from '../models/Inventory';
import { InventoryTransaction } from '../models/InventoryTransaction';
import { SaleItem } from '../models/SaleItem';
import { OrderItem } from '../models/OrderItem';
import { PurchaseItem } from '../models/PurchaseItem';
import { StockTransferItem } from '../models/StockTransferItem';
import { RefundItem } from '../models/RefundItem';
import { StockChannelSetting } from '../models/StockChannelSetting';
import { findBlockingReference } from '../services/referenceGuard';
import { recordAudit } from '../services/auditService';
import { Types } from 'mongoose';
import { imageUpload, publicUrlFor, removeUploadedFile } from '../utils/imageUpload';

/** Blocks deleting SKUs that any sale, order, purchase, transfer, refund or stock movement points at. */
async function skuDeleteBlocker(skuIds: Types.ObjectId[], label: string): Promise<string | null> {
  if (skuIds.length === 0) return null;
  const inSkus = { skuId: { $in: skuIds } };
  return findBlockingReference(label, [
    [InventoryTransaction, inSkus, 'ประวัติสต๊อก'],
    [Inventory, { ...inSkus, qtyOnHand: { $gt: 0 } }, 'สต๊อกคงเหลือ'],
    [SaleItem, inSkus, 'บิลขาย'],
    [OrderItem, inSkus, 'ออเดอร์ออนไลน์'],
    [PurchaseItem, inSkus, 'ใบรับสินค้า'],
    [StockTransferItem, inSkus, 'การโอนสต๊อก'],
    [RefundItem, inSkus, 'คำขอคืนสินค้า'],
  ]);
}

async function purgeSkus(skuIds: Types.ObjectId[]) {
  await Inventory.deleteMany({ skuId: { $in: skuIds } });
  await StockChannelSetting.deleteMany({ skuId: { $in: skuIds } });
  await ProductSku.deleteMany({ _id: { $in: skuIds } });
}

const router = Router();
router.use(requireAuth, requireActiveUser);

const productCreateSchema = z.object({
  name: z.string().min(1),
  shortCode: z.string().min(1),
  brandId: z.string().optional(),
  categoryId: z.string().optional(),
  type: z.enum(PRODUCT_TYPES),
  seriesName: z.string().optional(),
  dia: z.number().optional(),
  bc: z.number().optional(),
  wearDurationDays: z.number().optional(),
  unitOfMeasure: z.enum(UNIT_OF_MEASURE).optional(),
  defaultPriceRegular: z.number().min(0).optional(),
  defaultPowerPriceRegular: z.number().min(0).nullable().optional(),
  defaultCost: z.number().min(0).optional(),
  defaultMinStockLevel: z.number().min(0).optional(),
  description: z.string().optional(),
  images: z.array(z.string()).optional(),
});
const productUpdateSchema = productCreateSchema.partial().extend({
  active: z.boolean().optional(),
  /** Also rewrite priceRegular of this product's existing SKUs from the (new) plano/power prices. */
  applyPricesToSkus: z.boolean().optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { q, type, brandId, categoryId, active } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (q) {
      // Regex rather than $text: Thai names have no word boundaries for the text index to split on.
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = ['name', 'seriesName', 'shortCode'].map((f) => ({ [f]: { $regex: escaped, $options: 'i' } }));
    }
    if (type) filter.type = type;
    if (brandId) filter.brandId = brandId;
    if (categoryId) filter.categoryId = categoryId;
    if (active !== undefined) filter.active = active === 'true';
    const products = await Product.find(filter).populate('brandId categoryId').sort({ createdAt: -1 }).limit(500);
    res.json({ items: products });
  }),
);

router.get(
  '/low-stock',
  asyncHandler(async (req, res) => {
    const items = await getLowStockSkus(req.query.branchId as string | undefined);
    res.json({ items });
  }),
);

router.get(
  '/skus/search',
  asyncHandler(async (req, res) => {
    const { q, branchId } = req.query as { q?: string; branchId?: string };
    if (!branchId) throw ApiError.badRequest('branchId is required');
    const user = await User.findById(req.authUser!.id);
    const canViewCost = Boolean(await resolvePermission(user!, 'viewCost'));
    const results = await searchSkus({ q, branchId });
    res.json({
      items: results.map((r) => ({ ...sanitizeSku(r.sku, canViewCost), qtyOnHand: r.qtyOnHand })),
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id).populate('brandId categoryId');
    if (!product) throw ApiError.notFound();
    const variants = await ProductVariant.find({ productId: product._id });
    const user = await User.findById(req.authUser!.id);
    const canViewCost = Boolean(await resolvePermission(user!, 'viewCost'));
    const skus = await ProductSku.find({ productId: product._id }).sort({ power: 1 });
    const stock = await Inventory.find({ skuId: { $in: skus.map((s) => s._id) } }, 'skuId branchId qtyOnHand').lean();
    res.json({
      item: product,
      variants,
      skus: skus.map((s) => sanitizeSku(s, canViewCost)),
      stock,
    });
  }),
);

router.post(
  '/',
  requireRole('admin'),
  validateBody(productCreateSchema),
  asyncHandler(async (req, res) => {
    const product = await Product.create(req.body);
    res.status(201).json({ item: product });
  }),
);

router.patch(
  '/:id',
  requireRole('admin'),
  validateBody(productUpdateSchema),
  asyncHandler(async (req, res) => {
    const { applyPricesToSkus, ...fields } = req.body;
    const before = await Product.findById(req.params.id);
    if (!before) throw ApiError.notFound();
    const product = await Product.findByIdAndUpdate(req.params.id, { $set: fields }, { new: true });
    if (!product) throw ApiError.notFound();

    // Price buckets: plano (0.00 / no power) and every other power.
    const planoFilter = { productId: product._id, $or: [{ power: 0 }, { power: null }] };
    const powerFilter = { productId: product._id, power: { $nin: [0, null] } };
    const buckets = [
      { filter: planoFilter, oldPrice: priceForPower(before, 0), newPrice: priceForPower(product, 0) },
      { filter: powerFilter, oldPrice: priceForPower(before, -1), newPrice: priceForPower(product, -1) },
    ];

    let updatedSkus = 0;
    for (const { filter, oldPrice, newPrice } of buckets) {
      if (applyPricesToSkus) {
        // Force: every SKU in the bucket, including individually re-priced ones.
        updatedSkus += (await ProductSku.updateMany(filter, { $set: { priceRegular: newPrice } })).modifiedCount;
      } else if (oldPrice !== newPrice) {
        // Default: follow the product price, but leave SKUs that were given their own price alone.
        updatedSkus += (await ProductSku.updateMany({ ...filter, priceRegular: oldPrice }, { $set: { priceRegular: newPrice } })).modifiedCount;
      }
    }
    if (updatedSkus > 0) {
      await recordAudit({
        userId: req.authUser!.id,
        action: 'product.apply_prices',
        entityType: 'Product',
        entityId: product._id.toString(),
        before: { defaultPriceRegular: before.defaultPriceRegular, defaultPowerPriceRegular: before.defaultPowerPriceRegular },
        after: { defaultPriceRegular: product.defaultPriceRegular, defaultPowerPriceRegular: product.defaultPowerPriceRegular, updatedSkus, forced: Boolean(applyPricesToSkus) },
      });
    }
    res.json({ item: product, updatedSkus });
  }),
);

router.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound();
    const skuIds = await ProductSku.find({ productId: product._id }).distinct('_id');
    const blocked = await skuDeleteBlocker(skuIds, 'สินค้า');
    if (blocked) throw ApiError.conflict(blocked);

    await purgeSkus(skuIds);
    await ProductVariant.deleteMany({ productId: product._id });
    await product.deleteOne();
    await recordAudit({
      userId: req.authUser!.id,
      action: 'product.delete',
      entityType: 'Product',
      entityId: product._id.toString(),
      before: { ...product.toObject(), skuCount: skuIds.length },
    });
    res.status(204).send();
  }),
);

const variantCreateSchema = z.object({
  colorName: z.string().optional(),
  colorCode: z.string().regex(/^[A-Za-z0-9]{1,6}$/).optional(),
  images: z.array(z.string()).optional(),
});

router.post(
  '/:id/variants',
  requireRole('admin'),
  validateBody(variantCreateSchema),
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound();
    const count = await ProductVariant.countDocuments({ productId: product._id });
    const colorCode = req.body.colorCode ?? (req.body.colorName ? skuGen.deriveColorCode(req.body.colorName, count) : undefined);
    const variant = await ProductVariant.create({ ...req.body, colorCode, productId: product._id });
    res.status(201).json({ item: variant });
  }),
);

router.patch(
  '/variants/:variantId',
  requireRole('admin'),
  validateBody(variantCreateSchema.partial().extend({ active: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const variant = await ProductVariant.findByIdAndUpdate(req.params.variantId, { $set: req.body }, { new: true });
    if (!variant) throw ApiError.notFound();
    res.json({ item: variant });
  }),
);

router.delete(
  '/variants/:variantId',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const variant = await ProductVariant.findById(req.params.variantId);
    if (!variant) throw ApiError.notFound();
    const blocked = await findBlockingReference('สี/รุ่นย่อย', [[ProductSku, { variantId: variant._id }, 'SKU']]);
    if (blocked) throw ApiError.conflict(blocked);
    await variant.deleteOne();
    res.status(204).send();
  }),
);

const manualSkuCreateSchema = z.object({
  variantId: z.string().optional(),
  skuCode: z.string().min(1),
  barcode: z.string().optional(),
  power: z.number().optional(),
  priceRegular: z.number().min(0),
  priceMember: z.number().min(0).optional(),
  priceSpecial: z.number().min(0).optional(),
  cost: z.number().min(0),
  minStockLevel: z.number().min(0).optional(),
  unitOfMeasure: z.enum(UNIT_OF_MEASURE).optional(),
});

router.post(
  '/:id/skus',
  requireRole('admin'),
  validateBody(manualSkuCreateSchema),
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound();
    const sku = await ProductSku.create({
      ...req.body,
      productId: product._id,
      barcode: req.body.barcode || req.body.skuCode,
      unitOfMeasure: req.body.unitOfMeasure ?? product.unitOfMeasure,
    });
    res.status(201).json({ item: sku });
  }),
);

const skuUpdateSchema = z.object({
  barcode: z.string().min(1).optional(),
  power: z.number().optional(),
  unitOfMeasure: z.enum(UNIT_OF_MEASURE).optional(),
  priceRegular: z.number().min(0).optional(),
  priceMember: z.number().min(0).optional(),
  priceSpecial: z.number().min(0).optional(),
  cost: z.number().min(0).optional(),
  minStockLevel: z.number().min(0).optional(),
  active: z.boolean().optional(),
});

router.patch(
  '/skus/:skuId',
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.authUser!.id);
    const body = skuUpdateSchema.parse(req.body);

    if (body.cost !== undefined && !(await resolvePermission(user!, 'editCost'))) {
      throw ApiError.forbidden('You are not allowed to edit cost');
    }
    if (body.priceRegular !== undefined && !(await resolvePermission(user!, 'editMainPrice'))) {
      throw ApiError.forbidden('You are not allowed to edit the main price');
    }

    if ((body.barcode !== undefined || body.power !== undefined || body.unitOfMeasure !== undefined) && user!.role !== 'admin') {
      throw ApiError.forbidden('Only admins can edit SKU identity fields');
    }

    const sku = await ProductSku.findByIdAndUpdate(req.params.skuId, { $set: body }, { new: true });
    if (!sku) throw ApiError.notFound();
    const canViewCost = Boolean(await resolvePermission(user!, 'viewCost'));
    res.json({ item: sanitizeSku(sku, canViewCost) });
  }),
);

router.delete(
  '/skus/:skuId',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const sku = await ProductSku.findById(req.params.skuId);
    if (!sku) throw ApiError.notFound();
    const blocked = await skuDeleteBlocker([sku._id], 'SKU');
    if (blocked) throw ApiError.conflict(blocked);
    await purgeSkus([sku._id]);
    await recordAudit({
      userId: req.authUser!.id,
      action: 'sku.delete',
      entityType: 'ProductSku',
      entityId: sku._id.toString(),
      before: sku.toObject(),
    });
    res.status(204).send();
  }),
);

const rangeSchema = z.object({ from: z.number(), to: z.number(), step: z.number().positive() });

// --- Bulk: many models × many colors × many powers in one go ---
const stockEntrySchema = z.object({
  model: z.number().int().min(0),
  color: z.string().nullable(),
  power: z.number().nullable(),
  qty: z.number().int().min(0),
});
const colorInputSchema = z.object({ name: z.string().min(1), code: z.string().regex(/^[A-Za-z0-9]{0,6}$/).optional() });
const bulkSchema = z.object({
  models: z
    .array(z.object({ name: z.string().min(1), shortCode: z.string().min(1), seriesName: z.string().optional() }))
    .min(1)
    .max(50),
  common: productCreateSchema.omit({ name: true, shortCode: true, seriesName: true, images: true }),
  colors: z.array(colorInputSchema).max(40).default([]),
  ranges: z.array(rangeSchema).default([]),
  powers: z.array(z.number().min(-30).max(30)).max(200).default([]),
  branchId: z.string().optional(),
  stock: z.array(stockEntrySchema).max(10000).default([]),
});

router.post(
  '/bulk/preview',
  requireRole('admin'),
  validateBody(bulkSchema),
  asyncHandler(async (req, res) => {
    res.json(await productBulk.previewBulkProducts(req.body));
  }),
);

router.post(
  '/bulk',
  requireRole('admin'),
  validateBody(bulkSchema),
  asyncHandler(async (req, res) => {
    const result = await productBulk.bulkCreateProducts({ ...req.body, createdBy: req.authUser!.id });
    res.status(201).json({ items: result.products, skuCount: result.skuCount, stockQty: result.stockQty });
  }),
);

// --- Import from a spreadsheet (client parses the file and maps columns; server validates and writes) ---
const cell = z.union([z.string(), z.number()]).transform((v) => String(v)).optional();
const importSchema = z.object({
  rows: z
    .array(
      z.object({
        row: z.number().int(),
        name: cell,
        shortCode: cell,
        seriesName: cell,
        type: cell,
        brand: cell,
        category: cell,
        unit: cell,
        color: cell,
        colorCode: cell,
        powers: cell,
        price: cell,
        powerPrice: cell,
        cost: cell,
        minStock: cell,
        dia: cell,
        bc: cell,
        wearDays: cell,
        barcode: cell,
      }),
    )
    .min(1)
    .max(5000),
});

router.post(
  '/import/preview',
  requireRole('admin'),
  validateBody(importSchema),
  asyncHandler(async (req, res) => {
    res.json(await productImport.previewImport(req.body.rows));
  }),
);

router.post(
  '/import',
  requireRole('admin'),
  validateBody(importSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await productImport.importProducts(req.body.rows, req.authUser!.id));
  }),
);

const addColorsSchema = z.object({
  colors: z.array(colorInputSchema).min(1).max(40),
  ranges: z.array(rangeSchema).default([]),
  powers: z.array(z.number().min(-30).max(30)).max(200).default([]),
  branchId: z.string().optional(),
  stock: z.array(stockEntrySchema).max(10000).default([]),
});
router.post(
  '/:id/colors',
  requireRole('admin'),
  validateBody(addColorsSchema),
  asyncHandler(async (req, res) => {
    const { colors, ranges, powers, branchId, stock } = req.body;
    const result = await productBulk.addColorsToProduct(req.params.id, colors, ranges, req.authUser!.id, { powers, branchId, stock });
    res.status(201).json({ items: result.variants, skuCount: result.skuCount, stockQty: result.stockQty });
  }),
);
const generateSchema = z.object({
  variantId: z.string().optional(),
  ranges: z.array(rangeSchema).min(1),
  codeFormat: z.string().optional(),
});

router.post(
  '/:id/skus/generate/preview',
  requireRole('admin'),
  validateBody(generateSchema),
  asyncHandler(async (req, res) => {
    const preview = await skuGen.previewSkuGeneration({ productId: req.params.id, createdBy: req.authUser!.id, ...req.body });
    res.json(preview);
  }),
);

router.post(
  '/:id/skus/generate',
  requireRole('admin'),
  validateBody(generateSchema),
  asyncHandler(async (req, res) => {
    const result = await skuGen.generateSkus({ productId: req.params.id, createdBy: req.authUser!.id, ...req.body });
    res.status(201).json({
      batchId: result.batch._id,
      createdCount: result.createdSkus.length,
      skus: result.createdSkus,
    });
  }),
);

// --- Images (product = model photo, variant = color photo) ---
const removeImageSchema = z.object({ url: z.string().startsWith('/uploads/') });

router.post(
  '/:id/images',
  requireRole('admin'),
  imageUpload('products'),
  asyncHandler(async (req, res) => {
    const url = publicUrlFor('products', req.file!.filename);
    const product = await Product.findByIdAndUpdate(req.params.id, { $push: { images: url } }, { new: true });
    if (!product) {
      await removeUploadedFile(url);
      throw ApiError.notFound('Product not found');
    }
    res.status(201).json({ item: product, url });
  }),
);

router.delete(
  '/:id/images',
  requireRole('admin'),
  validateBody(removeImageSchema),
  asyncHandler(async (req, res) => {
    const product = await Product.findByIdAndUpdate(req.params.id, { $pull: { images: req.body.url } }, { new: true });
    if (!product) throw ApiError.notFound('Product not found');
    await removeUploadedFile(req.body.url);
    res.json({ item: product });
  }),
);

router.post(
  '/variants/:variantId/images',
  requireRole('admin'),
  imageUpload('products'),
  asyncHandler(async (req, res) => {
    const url = publicUrlFor('products', req.file!.filename);
    // One photo per color: the new one replaces the old.
    const before = await ProductVariant.findById(req.params.variantId);
    if (!before) {
      await removeUploadedFile(url);
      throw ApiError.notFound('Variant not found');
    }
    const variant = await ProductVariant.findByIdAndUpdate(req.params.variantId, { $set: { images: [url] } }, { new: true });
    for (const old of before.images) await removeUploadedFile(old);
    res.status(201).json({ item: variant, url });
  }),
);

router.delete(
  '/variants/:variantId/images',
  requireRole('admin'),
  validateBody(removeImageSchema),
  asyncHandler(async (req, res) => {
    const variant = await ProductVariant.findByIdAndUpdate(req.params.variantId, { $pull: { images: req.body.url } }, { new: true });
    if (!variant) throw ApiError.notFound('Variant not found');
    await removeUploadedFile(req.body.url);
    res.json({ item: variant });
  }),
);

// --- POS catalog: one tile per model, then colors/powers on tap ---
router.get(
  '/pos/catalog',
  asyncHandler(async (req, res) => {
    const { branchId } = req.query as { branchId?: string };
    if (!branchId) throw ApiError.badRequest('branchId is required');
    const [products, skus, inventories, variants] = await Promise.all([
      Product.find({ active: true }, { name: 1, type: 1, categoryId: 1, images: 1 }).populate('categoryId', 'name'),
      ProductSku.find({ active: true }, { productId: 1, priceRegular: 1 }),
      Inventory.find({ branchId, qtyOnHand: { $gt: 0 } }, { skuId: 1, qtyOnHand: 1 }),
      ProductVariant.find({ 'images.0': { $exists: true } }, { productId: 1, images: 1 }),
    ]);
    const qtyBySku = new Map(inventories.map((i) => [i.skuId.toString(), i.qtyOnHand]));
    const variantImage = new Map<string, string>();
    for (const v of variants) if (!variantImage.has(v.productId.toString())) variantImage.set(v.productId.toString(), v.images[0]);

    const stats = new Map<string, { min: number; max: number; count: number; qty: number; singleSkuId: string }>();
    for (const s of skus) {
      const key = s.productId.toString();
      const st = stats.get(key) ?? { min: Infinity, max: 0, count: 0, qty: 0, singleSkuId: s._id.toString() };
      st.min = Math.min(st.min, s.priceRegular);
      st.max = Math.max(st.max, s.priceRegular);
      st.count += 1;
      st.qty += qtyBySku.get(s._id.toString()) ?? 0;
      stats.set(key, st);
    }

    const items = products
      .filter((p) => stats.has(p._id.toString()))
      .map((p) => {
        const st = stats.get(p._id.toString())!;
        const category = p.categoryId as unknown as { _id: Types.ObjectId; name: string } | undefined;
        return {
          _id: p._id,
          name: p.name,
          type: p.type,
          category: category ? { _id: category._id, name: category.name } : null,
          image: p.images[0] ?? variantImage.get(p._id.toString()) ?? null,
          priceMin: st.min,
          priceMax: st.max,
          skuCount: st.count,
          singleSkuId: st.count === 1 ? st.singleSkuId : null,
          qtyOnHand: st.qty,
        };
      })
      .sort((a, b) => Number(b.qtyOnHand > 0) - Number(a.qtyOnHand > 0) || a.name.localeCompare(b.name, 'th'));
    res.json({ items });
  }),
);

router.get(
  '/:id/pos-options',
  asyncHandler(async (req, res) => {
    const { branchId } = req.query as { branchId?: string };
    if (!branchId) throw ApiError.badRequest('branchId is required');
    const product = await Product.findById(req.params.id, { name: 1, type: 1, images: 1 });
    if (!product) throw ApiError.notFound('Product not found');
    const [variants, skus] = await Promise.all([
      ProductVariant.find({ productId: product._id }, { colorName: 1, colorCode: 1, images: 1 }).sort({ colorName: 1 }),
      ProductSku.find({ productId: product._id, active: true }, { skuCode: 1, barcode: 1, power: 1, priceRegular: 1, variantId: 1, productId: 1 }),
    ]);
    const inventories = await Inventory.find({ branchId, skuId: { $in: skus.map((s) => s._id) } }, { skuId: 1, qtyOnHand: 1 });
    const qty = new Map(inventories.map((i) => [i.skuId.toString(), i.qtyOnHand]));
    res.json({
      product,
      variants,
      skus: skus
        .map((s) => ({ ...s.toObject(), qtyOnHand: qty.get(s._id.toString()) ?? 0 }))
        .sort((a, b) => (b.power ?? 0) - (a.power ?? 0)),
    });
  }),
);

export default router;
