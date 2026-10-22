import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth, requireActiveUser, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { User } from '../models/User';
import { resolvePermission } from '../services/permissionService';
import { applyReportHistoryLimit } from '../services/reportAccessService';
import * as reportService from '../services/reportService';

const router = Router();
router.use(requireAuth, requireActiveUser);

async function getRange(req: import('express').Request) {
  const user = await User.findById(req.authUser!.id);
  const { from, to } = req.query as Record<string, string>;
  const range = await applyReportHistoryLimit(user!, { from, to });
  return { from: range.from ?? new Date(0), to: range.to ?? new Date() };
}

router.get(
  '/daily-summary',
  asyncHandler(async (req, res) => {
    const { branchId, date } = req.query as Record<string, string>;
    await getRange(req); // enforces staff can only query today; date param below is validated against it
    res.json(await reportService.getDailySummary(branchId, date ? new Date(date) : new Date()));
  }),
);

const groupBySchema = z.enum(['day', 'week', 'month', 'shift', 'staff']);
router.get(
  '/sales',
  asyncHandler(async (req, res) => {
    const { branchId, groupBy } = req.query as Record<string, string>;
    const range = await getRange(req);
    res.json({ items: await reportService.getSalesReport({ branchId, ...range, groupBy: groupBySchema.parse(groupBy ?? 'day') }) });
  }),
);

const shiftFilterSchema = z.union([z.literal('unscheduled'), z.string().regex(/^[0-9a-f]{24}$/i)]).optional();
router.get(
  '/sales-by-shift',
  asyncHandler(async (req, res) => {
    const { branchId, shiftDefinitionId } = req.query as Record<string, string>;
    const range = await getRange(req);
    res.json(await reportService.getShiftSalesReport({ branchId, ...range, shiftDefinitionId: shiftFilterSchema.parse(shiftDefinitionId || undefined) }));
  }),
);

router.get(
  '/product-performance',
  asyncHandler(async (req, res) => {
    const { branchId } = req.query as Record<string, string>;
    const range = await getRange(req);
    res.json({ items: await reportService.getProductPerformanceReport({ branchId, ...range }) });
  }),
);

router.get(
  '/profit',
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.authUser!.id);
    if (!(await resolvePermission(user!, 'viewCost'))) throw ApiError.forbidden('You are not allowed to view profit data');
    const { branchId } = req.query as Record<string, string>;
    const range = await getRange(req);
    res.json(await reportService.getProfitReport({ branchId, ...range }));
  }),
);

router.get(
  '/expiry',
  asyncHandler(async (req, res) => {
    res.json({ items: await reportService.getExpiryReport(req.query.branchId as string | undefined) });
  }),
);

router.get(
  '/dead-stock',
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.authUser!.id);
    const canViewCost = Boolean(await resolvePermission(user!, 'viewCost'));
    const items = await reportService.getDeadStockReport(req.query.branchId as string | undefined);
    res.json({ items, costValueVisible: canViewCost });
  }),
);

router.get(
  '/cash-variance',
  requireRole('admin', 'branch_manager'),
  asyncHandler(async (req, res) => {
    const { branchId } = req.query as Record<string, string>;
    const range = await getRange(req);
    res.json(await reportService.getCashVarianceReport({ branchId, ...range }));
  }),
);

const granularitySchema = z.enum(['hour', 'weekday', 'dayOfMonth']);
router.get(
  '/sales-by-time',
  asyncHandler(async (req, res) => {
    const { branchId, granularity } = req.query as Record<string, string>;
    const range = await getRange(req);
    res.json({ items: await reportService.getSalesByTimeReport({ branchId, ...range, granularity: granularitySchema.parse(granularity ?? 'hour') }) });
  }),
);

export default router;
