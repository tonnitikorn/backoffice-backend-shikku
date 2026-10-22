import { Router } from 'express';
import { z } from 'zod';
import { ShiftDefinition } from '../models/ShiftDefinition';
import { ShiftSession } from '../models/ShiftSession';
import { ShiftStockCount } from '../models/ShiftStockCount';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireRole, requireBranchScope } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import * as shiftService from '../services/shiftService';
import * as scheduleService from '../services/scheduleService';
import * as cashMovementService from '../services/cashMovementService';
import * as stockCountService from '../services/stockCountService';
import { CASH_MOVEMENT_TYPES } from '../config/constants';
import { buildCrudRouter } from '../utils/crudFactory';
import { ShiftSchedule } from '../models/ShiftSchedule';
import { findBlockingReference } from '../services/referenceGuard';

const router = Router();
router.use(requireAuth, requireActiveUser);

// --- Shift definitions (templates, admin only) ---
const defCreateSchema = z.object({
  branchId: z.string(),
  name: z.string().min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  active: z.boolean().optional(),
});
router.use(
  '/definitions',
  buildCrudRouter({
    model: ShiftDefinition,
    createSchema: defCreateSchema,
    updateSchema: defCreateSchema.omit({ branchId: true }).partial(),
    writeRoles: ['admin'],
    filterFields: ['branchId'],
    sort: { startTime: 1 },
    deleteGuard: (def) =>
      findBlockingReference('รูปแบบกะ', [
        [ShiftSchedule, { shiftDefinitionId: def._id }, 'ตารางกะ'],
        [ShiftSession, { shiftDefinitionId: def._id }, 'กะการขาย'],
      ]),
  }),
);

// --- Schedule (calendar) ---
const monthSchema = z.object({ year: z.coerce.number(), month: z.coerce.number().min(1).max(12) });

router.get(
  '/schedule/calendar',
  asyncHandler(async (req, res) => {
    const { branchId } = req.query as { branchId: string };
    const month = monthSchema.parse(req.query);
    const entries = await scheduleService.getCalendar(branchId, month);
    res.json({ items: entries });
  }),
);

router.get(
  '/schedule/mine',
  asyncHandler(async (req, res) => {
    const month = monthSchema.parse(req.query);
    const entries = await scheduleService.getMySchedule(req.authUser!.id, month);
    res.json({ items: entries });
  }),
);

router.get(
  '/schedule/conflicts',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const month = monthSchema.parse(req.query);
    res.json(await scheduleService.detectScheduleConflicts(month));
  }),
);

const upsertScheduleSchema = z.object({
  branchId: z.string(),
  entries: z.array(z.object({ userId: z.string(), shiftDefinitionId: z.string(), date: z.string() })).min(1),
});
router.post(
  '/schedule',
  requireRole('admin'),
  validateBody(upsertScheduleSchema),
  asyncHandler(async (req, res) => {
    const entries = await scheduleService.upsertScheduleEntries(req.body.branchId, req.body.entries);
    res.status(201).json({ items: entries });
  }),
);

router.delete(
  '/schedule/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    await scheduleService.removeScheduleEntry(req.params.id);
    res.status(204).send();
  }),
);

const publishSchema = z.object({ branchId: z.string(), year: z.number(), month: z.number().min(1).max(12) });
router.post(
  '/schedule/publish',
  requireRole('admin'),
  validateBody(publishSchema),
  asyncHandler(async (req, res) => {
    const result = await scheduleService.publishSchedule(req.body.branchId, { year: req.body.year, month: req.body.month }, req.authUser!.id);
    res.json(result);
  }),
);

// --- Shift sessions (open/close/approve) ---
const openSchema = z.object({
  branchId: z.string(),
  openingFloat: z.number().min(0),
  openingFloatVarianceReason: z.string().optional(),
  approverId: z.string().optional(),
});
router.post(
  '/sessions/open',
  requireBranchScope(),
  validateBody(openSchema),
  asyncHandler(async (req, res) => {
    const session = await shiftService.openShift({ ...req.body, userId: req.authUser!.id });
    res.status(201).json({ item: session });
  }),
);

router.get(
  '/sessions/current',
  asyncHandler(async (req, res) => {
    const { branchId } = req.query as { branchId?: string };
    if (!branchId) throw ApiError.badRequest('branchId is required');
    const session = await shiftService.getOpenShiftForBranch(branchId);
    res.json({ item: session });
  }),
);

router.get(
  '/sessions/:id/expected-totals',
  asyncHandler(async (req, res) => {
    res.json(await shiftService.computeShiftExpectedTotals(req.params.id));
  }),
);

const closeSchema = z.object({
  closingCashCounted: z.number().min(0),
  closingTransferCounted: z.number().min(0),
  varianceReason: z.string().optional(),
  carryForwardFloat: z.number().min(0),
  cashHandedIn: z.number().min(0),
});
router.post(
  '/sessions/:id/close',
  validateBody(closeSchema),
  asyncHandler(async (req, res) => {
    const session = await shiftService.closeShift({ shiftSessionId: req.params.id, userId: req.authUser!.id, ...req.body });
    res.json({ item: session });
  }),
);

router.post(
  '/sessions/:id/approve',
  requireRole('admin', 'branch_manager'),
  asyncHandler(async (req, res) => {
    res.json({ item: await shiftService.approveShiftClose(req.params.id, req.authUser!.id) });
  }),
);

const rejectSchema = z.object({ reason: z.string().min(1) });
router.post(
  '/sessions/:id/reject',
  requireRole('admin', 'branch_manager'),
  validateBody(rejectSchema),
  asyncHandler(async (req, res) => {
    res.json({ item: await shiftService.rejectShiftClose(req.params.id, req.authUser!.id, req.body.reason) });
  }),
);

router.post(
  '/sessions/:id/reopen',
  requireRole('admin'),
  validateBody(rejectSchema),
  asyncHandler(async (req, res) => {
    res.json({ item: await shiftService.reopenShift(req.params.id, req.authUser!.id, req.body.reason) });
  }),
);

router.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const { branchId, status } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (branchId) filter.branchId = branchId;
    if (status) filter.status = status;
    const items = await ShiftSession.find(filter).sort({ createdAt: -1 }).limit(200).populate('userId branchId');
    res.json({ items });
  }),
);

const stockCountSchema = z.object({
  phase: z.enum(['open', 'close']),
  lines: z.array(z.object({ groupId: z.string(), countedQty: z.number().int().min(0) })).min(1),
  note: z.string().max(500).optional(),
});
router.post(
  '/sessions/:id/stock-count',
  validateBody(stockCountSchema),
  asyncHandler(async (req, res) => {
    await assertCanAccessShift(req, req.params.id);
    const { doc, handover } = await stockCountService.recordShiftStockCount({ shiftSessionId: req.params.id, ...req.body, userId: req.authUser!.id });
    res.status(201).json({ item: doc, handover });
  }),
);

/**
 * Groups to count, counts already saved, and the reference numbers from the previous count
 * (previous shift's "after" / this shift's "before"). Ledger quantities stay manager-only.
 */
router.get(
  '/sessions/:id/stock-count',
  asyncHandler(async (req, res) => {
    await assertCanAccessShift(req, req.params.id);
    const groups = await stockCountService.getActiveGroups();
    const counts = await ShiftStockCount.find({ shiftSessionId: req.params.id });
    const canSeeSystem = req.authUser!.role !== 'staff';
    const shape = (phase: 'open' | 'close') => {
      const c = counts.find((x) => x.phase === phase);
      if (!c) return null;
      return {
        countedAt: c.countedAt,
        note: c.note ?? null,
        lines: c.lines.map((l) => ({ groupId: l.groupId, countedQty: l.countedQty, systemQty: canSeeSystem ? l.systemQty : undefined })),
      };
    };
    const handover = counts.some((c) => c.phase === 'open') ? await stockCountService.getHandover(req.params.id) : null;
    const reference = groups.length > 0 ? await stockCountService.getCountReference(req.params.id) : null;
    // Header of the paper sheet: who, which shift, when, opening float.
    const shift = await ShiftSession.findById(req.params.id, { openedAt: 1, openingFloat: 1, status: 1, userId: 1, shiftDefinitionId: 1 })
      .populate('userId', 'name')
      .populate('shiftDefinitionId', 'name startTime endTime');
    res.json({ shift, groups: groups.map((g) => ({ _id: g._id, name: g.name, unitLabel: g.unitLabel })), open: shape('open'), close: shape('close'), handover, reference });
  }),
);

router.get(
  '/sessions/:id/summary',
  asyncHandler(async (req, res) => {
    await assertCanAccessShift(req, req.params.id);
    res.json(await stockCountService.getShiftSummary(req.params.id));
  }),
);

router.get(
  '/sessions/:id/sold-items',
  asyncHandler(async (req, res) => {
    await assertCanAccessShift(req, req.params.id);
    res.json(await shiftService.getShiftSoldItems(req.params.id));
  }),
);

async function assertCanAccessShift(req: import('express').Request, shiftSessionId: string) {
  const shift = await ShiftSession.findById(shiftSessionId, { branchId: 1 });
  if (!shift) throw ApiError.notFound('Shift session not found');
  if (req.authUser!.role !== 'admin' && !req.authUser!.branchIds.includes(shift.branchId.toString())) {
    throw ApiError.forbidden('You do not have access to this branch');
  }
}

// --- Cash movements ---
const cashMovementSchema = z.object({
  shiftSessionId: z.string(),
  type: z.enum(CASH_MOVEMENT_TYPES),
  amount: z.number().positive(),
  reason: z.string().min(1),
  receiptImage: z.string().optional(),
  createExpenseCategory: z.string().optional(),
});
router.post(
  '/cash-movements',
  validateBody(cashMovementSchema),
  asyncHandler(async (req, res) => {
    const movement = await cashMovementService.createCashMovement({ ...req.body, performedBy: req.authUser!.id });
    res.status(201).json({ item: movement });
  }),
);

const reverseSchema = z.object({ reason: z.string().min(1) });
router.post(
  '/cash-movements/:id/reverse',
  requireRole('admin', 'branch_manager'),
  validateBody(reverseSchema),
  asyncHandler(async (req, res) => {
    const movement = await cashMovementService.reverseCashMovement(req.params.id, req.authUser!.id, req.body.reason);
    res.status(201).json({ item: movement });
  }),
);

export default router;
