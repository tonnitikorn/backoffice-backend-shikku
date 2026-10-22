import { Router } from 'express';
import { Branch } from '../models/Branch';
import { DailySales } from '../models/DailySales';
import { ShiftSession } from '../models/ShiftSession';
import { Order } from '../models/Order';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth, requireActiveUser } from '../middleware/auth';
import * as reportService from '../services/reportService';
import { getLowStockSkus } from '../services/productService';

const router = Router();
router.use(requireAuth, requireActiveUser);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { branchId } = req.query as { branchId?: string };
    const isAdmin = req.authUser!.role === 'admin';
    const visibleBranchIds = branchId ? [branchId] : isAdmin ? undefined : req.authUser!.branchIds;

    const branchFilter = visibleBranchIds ? { _id: { $in: visibleBranchIds } } : {};
    const branches = await Branch.find(branchFilter);

    const today = new Date();
    const perBranch = await Promise.all(
      branches.map(async (branch) => {
        const summary = await reportService.getDailySummary(branch._id.toString(), today);
        const dayStart = new Date(today);
        dayStart.setHours(0, 0, 0, 0);
        const dailySales = await DailySales.findOne({ branchId: branch._id, date: dayStart });
        const openShift = await ShiftSession.findOne({ branchId: branch._id, status: 'open' });
        const pendingReview = await ShiftSession.countDocuments({ branchId: branch._id, status: 'pending_review' });
        const pendingOnlineOrders = await Order.countDocuments({ branchId: branch._id, orderStatus: { $in: ['pending', 'confirmed', 'packed'] } });
        const pendingTransfers = await reportService.getPendingTransferCount(branch._id.toString());
        const lowStock = await getLowStockSkus(branch._id.toString());

        return {
          branch,
          summary,
          shiftStatus: openShift ? 'selling' : pendingReview > 0 ? 'pending_review' : 'not_opened',
          dailySaleClosed: dailySales?.closedStatus === 'closed',
          pendingOnlineOrders,
          pendingTransfers,
          lowStockCount: lowStock.length,
        };
      }),
    );

    res.json({ branches: perBranch });
  }),
);

export default router;
