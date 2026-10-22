import { Router } from 'express';
import { AuditLog } from '../models/AuditLog';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth, requireActiveUser, requireRole } from '../middleware/auth';

const router = Router();
router.use(requireAuth, requireActiveUser, requireRole('admin', 'branch_manager'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { entityType, entityId, branchId } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (entityType) filter.entityType = entityType;
    if (entityId) filter.entityId = entityId;
    if (branchId) filter.branchId = branchId;
    const items = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(500).populate('userId');
    res.json({ items });
  }),
);

export default router;
