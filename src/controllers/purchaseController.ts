import { Request, Router } from 'express';
import { z } from 'zod';
import { Purchase } from '../models/Purchase';
import { PurchaseItem } from '../models/PurchaseItem';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireRole, requireBranchScope } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import * as purchaseService from '../services/purchaseService';
import { moveStock } from '../services/inventoryService';
import { withTransaction } from '../config/db';
import { recordAudit } from '../services/auditService';

const router = Router();
router.use(requireAuth, requireActiveUser);

const itemSchema = z.object({
  skuId: z.string(),
  qty: z.number().positive(),
  unitCost: z.number().min(0),
  lot: z.string().optional(),
  expiryDate: z.string().optional(),
});

const createSchema = z.object({
  supplierId: z.string(),
  branchId: z.string(),
  invoiceNo: z.string().optional(),
  purchaseDate: z.string(),
  discountTotal: z.number().min(0).optional(),
  vat: z.number().min(0).optional(),
  shippingCost: z.number().min(0).optional(),
  items: z.array(itemSchema).min(1),
});

router.post(
  '/',
  requireRole('admin', 'branch_manager'),
  requireBranchScope(),
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const result = await purchaseService.createPurchase({ ...req.body, createdBy: req.authUser!.id });
    res.status(201).json({ item: result.purchase, items: result.items });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { branchId, status } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (branchId) filter.branchId = branchId;
    if (status) filter.status = status;
    const items = await Purchase.find(filter).populate('supplierId branchId').sort({ createdAt: -1 }).limit(200);
    res.json({ items });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const result = await purchaseService.getPurchase(req.params.id);
    res.json(result);
  }),
);

/** Branch managers may only touch purchases of their own branches. */
async function assertPurchaseScope(req: Request, purchaseId: string) {
  const purchase = await Purchase.findById(purchaseId);
  if (!purchase) throw ApiError.notFound('Purchase not found');
  if (req.authUser!.role !== 'admin' && !req.authUser!.branchIds.includes(purchase.branchId.toString())) {
    throw ApiError.forbidden('You do not have access to this branch');
  }
}

router.patch(
  '/:id',
  requireRole('admin', 'branch_manager'),
  validateBody(createSchema.omit({ branchId: true }).partial()),
  asyncHandler(async (req, res) => {
    await assertPurchaseScope(req, req.params.id);
    const result = await purchaseService.updateDraftPurchase(req.params.id, req.body, req.authUser!.id);
    res.json(result);
  }),
);

router.delete(
  '/:id',
  requireRole('admin', 'branch_manager'),
  asyncHandler(async (req, res) => {
    await assertPurchaseScope(req, req.params.id);
    await purchaseService.deleteDraftPurchase(req.params.id, req.authUser!.id);
    res.status(204).send();
  }),
);

router.post(
  '/:id/confirm',
  requireRole('admin', 'branch_manager'),
  asyncHandler(async (req, res) => {
    const purchase = await purchaseService.confirmPurchase(req.params.id, req.authUser!.id);
    res.json({ item: purchase });
  }),
);

const adjustSchema = z.object({
  newQty: z.number().positive().optional(),
  newUnitCost: z.number().min(0).optional(),
  reason: z.string().min(1),
});

/**
 * Post-confirm corrections are admin-only (spec item 9): reverses the
 * original purchase_in movement and writes a fresh one reflecting the
 * corrected qty/cost, all inside one transaction, with an audit trail.
 */
router.patch(
  '/:id/items/:itemId/adjust',
  requireRole('admin'),
  validateBody(adjustSchema),
  asyncHandler(async (req, res) => {
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase || purchase.status !== 'confirmed') throw ApiError.badRequest('Purchase must be confirmed to adjust');
    const item = await PurchaseItem.findById(req.params.itemId);
    if (!item || item.purchaseId.toString() !== purchase._id.toString()) throw ApiError.notFound('Purchase item not found');

    const before = item.toObject();
    const newQty = req.body.newQty ?? item.qty;
    const newUnitCost = req.body.newUnitCost ?? item.finalUnitCost;
    const qtyDelta = newQty - item.qty;

    await withTransaction(async (session) => {
      if (qtyDelta !== 0) {
        await moveStock({
          branchId: purchase.branchId,
          skuId: item.skuId,
          type: qtyDelta > 0 ? 'adjustment_increase' : 'adjustment_decrease',
          qty: Math.abs(qtyDelta),
          reason: `Purchase item adjustment: ${req.body.reason}`,
          refType: 'Purchase',
          refId: purchase._id,
          performedBy: req.authUser!.id,
          session,
        });
      }

      item.qty = newQty;
      item.finalUnitCost = newUnitCost;
      await item.save({ session });

      await recordAudit(
        {
          userId: req.authUser!.id,
          branchId: purchase.branchId,
          action: 'purchase.item_adjust',
          entityType: 'PurchaseItem',
          entityId: item._id.toString(),
          before,
          after: item.toObject(),
        },
        session,
      );
    });

    res.json({ item });
  }),
);

export default router;
