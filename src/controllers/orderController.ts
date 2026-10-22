import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireRole } from '../middleware/auth';
import * as orderService from '../services/orderService';
import { SALE_CHANNELS, PAYMENT_METHODS, ORDER_STATUSES } from '../config/constants';

const router = Router();
router.use(requireAuth, requireActiveUser);

// Online orders are entered by the shop owner from chat (spec item 7) — admin only.
router.use(requireRole('admin'));

const itemSchema = z.object({ skuId: z.string(), qty: z.number().positive() });
const paymentSchema = z.object({ method: z.enum(PAYMENT_METHODS), amount: z.number().int().positive(), referenceNo: z.string().optional() });

const createSchema = z.object({
  branchId: z.string(),
  customerId: z.string().optional(),
  channel: z.enum(SALE_CHANNELS.filter((c) => c !== 'store') as [string, ...string[]]),
  items: z.array(itemSchema).min(1),
  shippingMethod: z.string().optional(),
  shippingAddress: z.string().optional(),
  couponCode: z.string().optional(),
  promotionIds: z.array(z.string()).optional(),
  payments: z.array(paymentSchema).optional(),
  idempotencyKey: z.string().optional(),
});

router.post(
  '/',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const order = await orderService.createOrder({
      ...req.body,
      idempotencyKey: req.body.idempotencyKey ?? nanoid(),
      createdBy: req.authUser!.id,
    });
    res.status(201).json({ item: order });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { branchId, orderStatus, channel } = req.query as Record<string, string>;
    res.json({ items: await orderService.listOrders({ branchId, orderStatus, channel }) });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await orderService.getOrder(req.params.id));
  }),
);

const statusSchema = z.object({ status: z.enum(ORDER_STATUSES), note: z.string().optional() });
router.patch(
  '/:id/status',
  validateBody(statusSchema),
  asyncHandler(async (req, res) => {
    const order = await orderService.updateOrderStatus(req.params.id, req.body.status, req.authUser!.id, req.body.note);
    res.json({ item: order });
  }),
);

export default router;
