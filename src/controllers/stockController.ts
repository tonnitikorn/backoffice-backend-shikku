import { Router } from 'express';
import { z } from 'zod';
import { Inventory } from '../models/Inventory';
import { InventoryTransaction } from '../models/InventoryTransaction';
import { StockChannelSetting } from '../models/StockChannelSetting';
import { STOCK_CHANNEL_MODES } from '../config/constants';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireRole, requireBranchScope } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { withTransaction } from '../config/db';
import { moveStock } from '../services/inventoryService';
import { resolvePermission } from '../services/permissionService';
import { applyReportHistoryLimit } from '../services/reportAccessService';
import { User } from '../models/User';
import { ProductSku } from '../models/ProductSku';
import { StockPhotoScan } from '../models/StockPhotoScan';
import * as stockPhotoScanService from '../services/stockPhotoScanService';
import { imageUpload, publicUrlFor, removeUploadedFile } from '../utils/imageUpload';

const router = Router();
router.use(requireAuth, requireActiveUser);

const adjustSchema = z.object({
  branchId: z.string(),
  skuId: z.string(),
  newQty: z.number().int().min(0),
  reason: z.string().min(1),
});

router.post(
  '/adjust',
  requireRole('admin', 'branch_manager'),
  requireBranchScope(),
  validateBody(adjustSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.authUser!.id);
    if (!(await resolvePermission(user!, 'adjustStock'))) throw ApiError.forbidden();

    const { branchId, skuId, newQty, reason } = req.body;
    const current = await Inventory.findOne({ branchId, skuId });
    const oldQty = current?.qtyOnHand ?? 0;
    const delta = newQty - oldQty;
    if (delta === 0) throw ApiError.badRequest('New quantity is the same as current quantity');

    const result = await withTransaction(async (session) => {
      return moveStock({
        branchId,
        skuId,
        type: delta > 0 ? 'adjustment_increase' : 'adjustment_decrease',
        qty: Math.abs(delta),
        reason,
        performedBy: req.authUser!.id,
        refType: 'Adjustment',
        session,
      });
    });

    res.json({ oldQty, newQty, delta, balanceAfter: result.balanceAfter });
  }),
);

const addBulkSchema = z.object({
  branchId: z.string(),
  reason: z.string().min(1),
  items: z
    .array(z.object({ skuId: z.string().regex(/^[0-9a-f]{24}$/i), qty: z.number().int().positive() }))
    .min(1)
    .max(5000),
});

/** Top up many SKUs at once (+qty each) — all or nothing, one ledger entry per SKU. */
router.post(
  '/add-bulk',
  requireRole('admin', 'branch_manager'),
  requireBranchScope(),
  validateBody(addBulkSchema),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.authUser!.id);
    if (!(await resolvePermission(user!, 'adjustStock'))) throw ApiError.forbidden();

    const { branchId, reason, items } = req.body as z.infer<typeof addBulkSchema>;
    // The same SKU listed twice is one top-up of the summed quantity.
    const bySku = new Map<string, number>();
    for (const i of items) bySku.set(i.skuId, (bySku.get(i.skuId) ?? 0) + i.qty);
    const skuIds = Array.from(bySku.keys());
    const found = await ProductSku.countDocuments({ _id: { $in: skuIds } });
    if (found !== skuIds.length) throw ApiError.badRequest('พบ SKU ที่ไม่มีในระบบ');

    await withTransaction(async (session) => {
      for (const [skuId, qty] of bySku) {
        await moveStock({ branchId, skuId, type: 'adjustment_increase', qty, reason, performedBy: req.authUser!.id, refType: 'Adjustment', session });
      }
    });

    res.json({ skuCount: skuIds.length, totalQty: Array.from(bySku.values()).reduce((a, b) => a + b, 0) });
  }),
);

const writeOffSchema = z.object({
  branchId: z.string(),
  skuId: z.string(),
  qty: z.number().positive(),
  type: z.enum(['damage_out', 'internal_use_out']),
  reason: z.string().min(1),
});

router.post(
  '/write-off',
  requireRole('admin', 'branch_manager'),
  requireBranchScope(),
  validateBody(writeOffSchema),
  asyncHandler(async (req, res) => {
    const { branchId, skuId, qty, type, reason } = req.body;
    const result = await withTransaction((session) =>
      moveStock({ branchId, skuId, type, qty, reason, performedBy: req.authUser!.id, refType: 'Adjustment', session }),
    );
    res.json({ balanceAfter: result.balanceAfter });
  }),
);

router.get(
  '/current',
  asyncHandler(async (req, res) => {
    const { branchId, skuId } = req.query as { branchId?: string; skuId?: string };
    const filter: Record<string, unknown> = {};
    if (branchId) filter.branchId = branchId;
    if (skuId) filter.skuId = skuId;
    const user = await User.findById(req.authUser!.id);
    const canViewCost = Boolean(await resolvePermission(user!, 'viewCost'));
    const items = await Inventory.find(filter)
      .populate({
        path: 'skuId',
        select: canViewCost ? undefined : '-cost',
        populate: [
          { path: 'productId', select: 'name' },
          { path: 'variantId', select: 'colorName' },
        ],
      })
      .populate('branchId', 'name code');
    res.json({ items });
  }),
);

router.get(
  '/ledger',
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.authUser!.id);
    const { branchId, skuId, from, to } = req.query as Record<string, string>;

    const filter: Record<string, unknown> = {};
    if (branchId) filter.branchId = branchId;
    if (skuId) filter.skuId = skuId;

    const range = await applyReportHistoryLimit(user!, { from, to });
    if (range.from || range.to) {
      filter.createdAt = {};
      if (range.from) (filter.createdAt as Record<string, Date>).$gte = range.from;
      if (range.to) (filter.createdAt as Record<string, Date>).$lte = range.to;
    }

    const items = await InventoryTransaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .populate('skuId', 'skuCode power productId')
      .populate('performedBy', 'name');
    res.json({ items });
  }),
);

const channelSettingSchema = z.object({
  branchId: z.string(),
  skuId: z.string(),
  mode: z.enum(STOCK_CHANNEL_MODES),
  onlineReservedQty: z.number().min(0).optional(),
});

router.get(
  '/channel-settings',
  asyncHandler(async (req, res) => {
    const { branchId, skuId } = req.query as { branchId?: string; skuId?: string };
    const filter: Record<string, unknown> = {};
    if (branchId) filter.branchId = branchId;
    if (skuId) filter.skuId = skuId;
    const items = await StockChannelSetting.find(filter);
    res.json({ items });
  }),
);

router.put(
  '/channel-settings',
  requireRole('admin'),
  validateBody(channelSettingSchema),
  asyncHandler(async (req, res) => {
    const { branchId, skuId, mode, onlineReservedQty = 0 } = req.body;
    const doc = await StockChannelSetting.findOneAndUpdate(
      { branchId, skuId },
      { $set: { mode, onlineReservedQty } },
      { upsert: true, new: true },
    );

    // Sync the ring-fenced slice onto Inventory so the atomic sale guard
    // (inventoryService.moveStock) can read it as part of one document.
    const inv = await Inventory.findOne({ branchId, skuId });
    const currentQty = inv?.qtyOnHand ?? 0;
    const targetReserved = mode === 'split' ? Math.min(onlineReservedQty, currentQty) : 0;
    await Inventory.findOneAndUpdate(
      { branchId, skuId },
      { $set: { onlineReservedQty: targetReserved }, $setOnInsert: { qtyOnHand: 0 } },
      { upsert: true },
    );

    res.json({ item: doc });
  }),
);

// --- Read a tray photo (AI) to pre-fill the stock top-up form ---
async function assertCanAdjust(req: import('express').Request) {
  const user = await User.findById(req.authUser!.id);
  if (!(await resolvePermission(user!, 'adjustStock'))) throw ApiError.forbidden();
}

router.get(
  '/photo-scans/config',
  asyncHandler(async (_req, res) => {
    res.json({ configured: stockPhotoScanService.isScanConfigured() });
  }),
);

router.post(
  '/photo-scans',
  requireRole('admin', 'branch_manager'),
  imageUpload('stock-scans'),
  requireBranchScope(),
  asyncHandler(async (req, res) => {
    await assertCanAdjust(req);
    const imageUrl = publicUrlFor('stock-scans', req.file!.filename);
    try {
      const scan = await stockPhotoScanService.startScan({ branchId: req.body.branchId, imageUrl, userId: req.authUser!.id });
      res.status(202).json({ item: scan });
    } catch (err) {
      await removeUploadedFile(imageUrl);
      throw err;
    }
  }),
);

// Without an API key: the prompt to paste into the Claude app together with the photo.
router.get(
  '/photo-scans/prompt',
  requireRole('admin', 'branch_manager'),
  asyncHandler(async (_req, res) => {
    res.json({ prompt: await stockPhotoScanService.manualPrompt() });
  }),
);

// Names/codes/photos come along so the top-up form can show the rows without extra lookups.
async function findScanForUser(req: import('express').Request) {
  const scan = await StockPhotoScan.findById(req.params.id)
    .populate('rows.productId', 'name')
    .populate('rows.variantId', 'colorName images')
    .populate('rows.skuId', 'skuCode power')
    .populate('samples.variantId', 'colorName images');
  if (!scan) throw ApiError.notFound('Scan not found');
  if (req.authUser!.role !== 'admin' && !req.authUser!.branchIds.includes(scan.branchId.toString())) throw ApiError.forbidden();
  return scan;
}

router.get(
  '/photo-scans/:id',
  requireRole('admin', 'branch_manager'),
  asyncHandler(async (req, res) => {
    res.json({ item: await findScanForUser(req) });
  }),
);

// The Claude app's reply for an 'awaiting' scan.
router.post(
  '/photo-scans/:id/result',
  requireRole('admin', 'branch_manager'),
  asyncHandler(async (req, res) => {
    await assertCanAdjust(req);
    await findScanForUser(req);
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) throw ApiError.badRequest('กรุณาวางคำตอบจาก Claude');
    await stockPhotoScanService.applyPastedResult(req.params.id, text);
    res.json({ item: await findScanForUser(req) });
  }),
);

export default router;
