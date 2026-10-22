import { z } from 'zod';
import { Router } from 'express';
import { Promotion } from '../models/Promotion';
import { Coupon } from '../models/Coupon';
import { PROMOTION_TYPES, SALE_CHANNELS } from '../config/constants';
import { buildCrudRouter } from '../utils/crudFactory';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { Sale } from '../models/Sale';
import { SaleItem } from '../models/SaleItem';
import { Order } from '../models/Order';
import { OrderItem } from '../models/OrderItem';
import { findBlockingReference } from '../services/referenceGuard';
import { recordAudit } from '../services/auditService';

const promotionSchema = z.object({
  name: z.string().min(1),
  type: z.enum(PROMOTION_TYPES),
  scopeBranchIds: z.array(z.string()).optional(),
  scopeChannels: z.array(z.enum(SALE_CHANNELS)).optional(),
  scopeSkuIds: z.array(z.string()).optional(),
  scopeMemberLevelIds: z.array(z.string()).optional(),
  startAt: z.string(),
  endAt: z.string(),
  stackable: z.boolean().optional(),
  config: z
    .object({
      percentOff: z.number().optional(),
      amountOff: z.number().optional(),
      buyQty: z.number().optional(),
      getQty: z.number().optional(),
      spendThreshold: z.number().optional(),
      spendDiscountAmount: z.number().optional(),
    })
    .optional(),
  active: z.boolean().optional(),
});

const promotionRouter = buildCrudRouter({
  model: Promotion,
  createSchema: promotionSchema,
  updateSchema: promotionSchema.partial(),
  writeRoles: ['admin'],
  searchFields: ['name'],
  deleteGuard: (promo) =>
    findBlockingReference('โปรโมชั่น', [
      [Coupon, { promotionId: promo._id }, 'คูปอง'],
      [Sale, { cartPromotionId: promo._id }, 'บิลขาย'],
      [SaleItem, { promotionId: promo._id }, 'บิลขาย'],
      [Order, { cartPromotionId: promo._id }, 'ออเดอร์ออนไลน์'],
      [OrderItem, { promotionId: promo._id }, 'ออเดอร์ออนไลน์'],
    ]),
});

const couponSchema = z.object({
  code: z.string().min(1),
  promotionId: z.string(),
  usageLimit: z.number().optional(),
  perCustomerLimit: z.number().optional(),
  active: z.boolean().optional(),
});

const couponRouter: Router = Router();
couponRouter.use(requireAuth, requireActiveUser);
couponRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ items: await Coupon.find().populate('promotionId').sort({ createdAt: -1 }).limit(200) });
  }),
);
couponRouter.post(
  '/',
  requireRole('admin'),
  validateBody(couponSchema),
  asyncHandler(async (req, res) => {
    const item = await Coupon.create(req.body);
    res.status(201).json({ item });
  }),
);
couponRouter.patch(
  '/:id',
  requireRole('admin'),
  validateBody(couponSchema.partial()),
  asyncHandler(async (req, res) => {
    const item = await Coupon.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!item) throw ApiError.notFound();
    res.json({ item });
  }),
);

couponRouter.delete(
  '/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) throw ApiError.notFound();
    const blocked =
      coupon.usedCount > 0
        ? 'คูปองนี้ถูกใช้งานแล้ว ลบไม่ได้ — กรุณาปิดใช้งานแทน'
        : await findBlockingReference('คูปอง', [
            [Sale, { couponId: coupon._id }, 'บิลขาย'],
            [Order, { couponId: coupon._id }, 'ออเดอร์ออนไลน์'],
          ]);
    if (blocked) throw ApiError.conflict(blocked);
    await coupon.deleteOne();
    await recordAudit({
      userId: req.authUser!.id,
      action: 'coupon.delete',
      entityType: 'Coupon',
      entityId: coupon._id.toString(),
      before: coupon.toObject(),
    });
    res.status(204).send();
  }),
);

export { promotionRouter, couponRouter };
