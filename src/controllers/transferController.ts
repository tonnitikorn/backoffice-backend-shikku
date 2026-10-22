import { Router } from 'express';
import { z } from 'zod';
import { StockTransfer } from '../models/StockTransfer';
import { StockTransferItem } from '../models/StockTransferItem';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import * as transferService from '../services/transferService';

const router = Router();
router.use(requireAuth, requireActiveUser, requireRole('admin', 'branch_manager'));

const itemSchema = z.object({ skuId: z.string(), qty: z.number().positive(), lot: z.string().optional(), expiryDate: z.string().optional() });
const createSchema = z.object({
  fromBranchId: z.string(),
  toBranchId: z.string(),
  items: z.array(itemSchema).min(1),
});

router.post(
  '/',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const transfer = await transferService.createTransfer({ ...req.body, sentBy: req.authUser!.id });
    res.status(201).json({ item: transfer });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { branchId, status } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (branchId) filter.$or = [{ fromBranchId: branchId }, { toBranchId: branchId }];
    if (status) filter.status = status;
    const items = await StockTransfer.find(filter).populate('fromBranchId toBranchId sentBy receivedBy').sort({ createdAt: -1 }).limit(200);
    res.json({ items });
  }),
);

router.get(
  '/in-transit-summary',
  asyncHandler(async (req, res) => {
    res.json({ items: await transferService.getInTransitSummary(req.query.branchId as string | undefined) });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const transfer = await StockTransfer.findById(req.params.id).populate('fromBranchId toBranchId sentBy receivedBy');
    if (!transfer) throw ApiError.notFound();
    const items = await StockTransferItem.find({ transferId: transfer._id }).populate('skuId');
    res.json({ item: transfer, items });
  }),
);

const inTransitSchema = z.object({ carrierInfo: z.string().optional() });
router.post(
  '/:id/mark-in-transit',
  validateBody(inTransitSchema),
  asyncHandler(async (req, res) => {
    res.json({ item: await transferService.markInTransit(req.params.id, req.body.carrierInfo, req.authUser!.id) });
  }),
);

const receiveSchema = z.object({
  items: z.array(z.object({ itemId: z.string(), qtyReceived: z.number().min(0), discrepancyReason: z.string().optional() })).min(1),
});
router.post(
  '/:id/receive',
  validateBody(receiveSchema),
  asyncHandler(async (req, res) => {
    res.json({ item: await transferService.receiveTransfer(req.params.id, { ...req.body, userId: req.authUser!.id }) });
  }),
);

const resolveSchema = z.object({ resolution: z.enum(['damaged', 'lost', 'admin_confirmed']) });
router.post(
  '/items/:itemId/resolve-discrepancy',
  requireRole('admin'),
  validateBody(resolveSchema),
  asyncHandler(async (req, res) => {
    res.json({ item: await transferService.resolveDiscrepancy(req.params.itemId, req.body.resolution, req.authUser!.id) });
  }),
);

const cancelSchema = z.object({ reason: z.string().min(1) });
router.post(
  '/:id/cancel',
  requireRole('admin', 'branch_manager'),
  validateBody(cancelSchema),
  asyncHandler(async (req, res) => {
    res.json({ item: await transferService.cancelTransfer(req.params.id, req.authUser!.id, req.body.reason) });
  }),
);

export default router;
