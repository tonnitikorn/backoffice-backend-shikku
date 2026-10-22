import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireRole } from '../middleware/auth';
import * as refundService from '../services/refundService';
import { REFUND_TYPES, ITEM_CONDITIONS, STOCK_DESTINATIONS, PAYMENT_METHODS } from '../config/constants';

const router = Router();
router.use(requireAuth, requireActiveUser);

const createSchema = z.object({
  originalType: z.enum(['Sale', 'Order']),
  originalId: z.string(),
  type: z.enum(REFUND_TYPES),
  items: z.array(
    z.object({
      originalItemId: z.string(),
      qty: z.number().positive(),
      condition: z.enum(ITEM_CONDITIONS),
      stockDestinationOverride: z.enum(STOCK_DESTINATIONS).optional(),
    }),
  ).min(1),
  reason: z.string().min(1),
});

router.post(
  '/',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const refund = await refundService.createRefundRequest({ ...req.body, requestedBy: req.authUser!.id });
    res.status(201).json({ item: refund });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { branchId, status } = req.query as Record<string, string>;
    res.json({ items: await refundService.listRefunds({ branchId, status }) });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await refundService.getRefund(req.params.id));
  }),
);

const approveSchema = z.object({
  refundChannelLines: z.array(z.object({ method: z.enum(PAYMENT_METHODS), amount: z.number().int().positive() })).min(1),
});
router.post(
  '/:id/approve',
  requireRole('admin', 'branch_manager'),
  validateBody(approveSchema),
  asyncHandler(async (req, res) => {
    const refund = await refundService.approveRefund(req.params.id, req.authUser!.id, req.body.refundChannelLines);
    res.json({ item: refund });
  }),
);

const rejectSchema = z.object({ reason: z.string().min(1) });
router.post(
  '/:id/reject',
  requireRole('admin', 'branch_manager'),
  validateBody(rejectSchema),
  asyncHandler(async (req, res) => {
    res.json({ item: await refundService.rejectRefund(req.params.id, req.authUser!.id, req.body.reason) });
  }),
);

export default router;
