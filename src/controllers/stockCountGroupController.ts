import { Router } from 'express';
import { z } from 'zod';
import { StockCountGroup, POWER_FILTERS } from '../models/StockCountGroup';
import { asyncHandler } from '../utils/asyncHandler';
import { buildCrudRouter } from '../utils/crudFactory';
import { requireAuth, requireActiveUser, requireRole, requireBranchScope } from '../middleware/auth';
import * as stockCountService from '../services/stockCountService';

const router = Router();

router.post(
  '/bootstrap',
  requireAuth,
  requireActiveUser,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    res.status(201).json({ items: await stockCountService.createDefaultGroups(req.authUser!.id) });
  }),
);

router.get(
  '/ungrouped-products',
  requireAuth,
  requireActiveUser,
  asyncHandler(async (_req, res) => {
    res.json({ items: await stockCountService.getUngroupedProducts() });
  }),
);

/** Ledger qty per group — for managers checking the sheet, not shown to staff before they count. */
router.get(
  '/system-qty',
  requireAuth,
  requireActiveUser,
  requireRole('admin', 'branch_manager'),
  requireBranchScope(),
  asyncHandler(async (req, res) => {
    const groups = await stockCountService.getActiveGroups();
    const qty = await stockCountService.getSystemQtyByGroup(req.query.branchId as string, groups);
    res.json({ items: groups.map((g) => ({ groupId: g._id, name: g.name, qty: qty.get(g._id.toString()) ?? 0 })) });
  }),
);

const createSchema = z.object({
  name: z.string().min(1),
  sortOrder: z.number().int().optional(),
  productIds: z.array(z.string().regex(/^[0-9a-f]{24}$/i)).default([]),
  powerFilter: z.enum(POWER_FILTERS).default('any'),
  unitLabel: z.string().min(1).default('ชิ้น'),
  active: z.boolean().optional(),
});

router.use(
  '/',
  buildCrudRouter({
    model: StockCountGroup,
    createSchema,
    updateSchema: createSchema.partial(),
    writeRoles: ['admin'],
    sort: { sortOrder: 1, name: 1 },
  }),
);

export default router;
