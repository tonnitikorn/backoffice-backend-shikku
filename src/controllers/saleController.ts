import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { ProductSku } from '../models/ProductSku';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireBranchScope } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import * as saleService from '../services/saleService';
import { evaluateCart, applyPriceOverrides, listPromotionOptions } from '../services/promotionService';
import { PAYMENT_METHODS, SALE_CHANNELS } from '../config/constants';

const router = Router();
router.use(requireAuth, requireActiveUser);

const itemSchema = z.object({
  skuId: z.string(),
  qty: z.number().positive(),
  unitPriceOverride: z.number().int().min(0).optional(),
  overrideReason: z.string().max(200).optional(),
  allowOversell: z.boolean().optional(),
});
const paymentSchema = z.object({ method: z.enum(PAYMENT_METHODS), amount: z.number().int().positive(), referenceNo: z.string().optional() });

const quoteSchema = z.object({
  branchId: z.string(),
  channel: z.enum(SALE_CHANNELS).optional(),
  customerId: z.string().optional(),
  items: z.array(itemSchema).min(1),
  promotionIds: z.array(z.string()).optional(),
  couponCode: z.string().optional(),
});

router.post(
  '/quote',
  validateBody(quoteSchema),
  asyncHandler(async (req, res) => {
    const skus = await ProductSku.find({ _id: { $in: req.body.items.map((i: { skuId: string }) => i.skuId) } });
    const skuMap = new Map(skus.map((s) => [s._id.toString(), s]));
    const items = req.body.items as z.infer<typeof itemSchema>[];
    const lines = items.map((i) => {
      const sku = skuMap.get(i.skuId);
      if (!sku) throw ApiError.badRequest(`SKU not found: ${i.skuId}`);
      return { sku, qty: i.qty };
    });
    const overrides = new Map(items.filter((i) => i.unitPriceOverride !== undefined).map((i) => [i.skuId, i.unitPriceOverride!]));
    const result = applyPriceOverrides(
      await evaluateCart({
        branchId: req.body.branchId,
        channel: req.body.channel ?? 'store',
        customerId: req.body.customerId,
        lines,
        promotionIds: req.body.promotionIds,
        couponCode: req.body.couponCode,
      }),
      overrides,
    );
    const promotionOptions = await listPromotionOptions({
      branchId: req.body.branchId,
      channel: req.body.channel ?? 'store',
      customerId: req.body.customerId,
      lines,
    });
    res.json({ ...result, promotionOptions });
  }),
);

const createSchema = z.object({
  branchId: z.string(),
  shiftSessionId: z.string(),
  channel: z.enum(SALE_CHANNELS).optional(),
  customerId: z.string().optional(),
  items: z.array(itemSchema).min(1),
  payments: z.array(paymentSchema).default([]),
  promotionIds: z.array(z.string()).optional(),
  couponCode: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

router.post(
  '/',
  requireBranchScope(),
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const sale = await saleService.createSale({
      ...req.body,
      idempotencyKey: req.body.idempotencyKey ?? nanoid(),
      soldBy: req.authUser!.id,
    });
    res.status(201).json({ item: sale });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { branchId, shiftSessionId, from, to } = req.query as Record<string, string>;
    const items = await saleService.listSales({
      branchId,
      shiftSessionId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    res.json({ items });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await saleService.getSale(req.params.id));
  }),
);

export default router;
