import { Router } from 'express';
import { z } from 'zod';
import { Customer } from '../models/Customer';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { Sale } from '../models/Sale';
import { Order } from '../models/Order';
import { findBlockingReference } from '../services/referenceGuard';
import { recordAudit } from '../services/auditService';

const router = Router();
router.use(requireAuth, requireActiveUser);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { q } = req.query as { q?: string };
    const filter: Record<string, unknown> = {};
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ name: { $regex: escaped, $options: 'i' } }, { phone: { $regex: escaped, $options: 'i' } }, { email: { $regex: escaped, $options: 'i' } }];
    }
    const items = await Customer.find(filter).populate('memberLevelId').sort({ createdAt: -1 }).limit(200);
    res.json({ items });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const item = await Customer.findById(req.params.id).populate('memberLevelId');
    if (!item) throw ApiError.notFound();
    res.json({ item });
  }),
);

const createSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  address: z.string().optional(),
  birthday: z.string().optional(),
  lineUserId: z.string().optional(),
  memberLevelId: z.string().nullable().optional(),
});

router.post(
  '/',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const { memberLevelId, ...rest } = req.body;
    const item = await Customer.create(memberLevelId ? { ...rest, memberLevelId } : rest);
    res.status(201).json({ item });
  }),
);

router.patch(
  '/:id',
  validateBody(createSchema.partial()),
  asyncHandler(async (req, res) => {
    const { memberLevelId, ...rest } = req.body;
    const update: Record<string, unknown> = { $set: rest };
    if (memberLevelId === null || memberLevelId === '') update.$unset = { memberLevelId: 1 };
    else if (memberLevelId !== undefined) (update.$set as Record<string, unknown>).memberLevelId = memberLevelId;
    const item = await Customer.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!item) throw ApiError.notFound();
    res.json({ item });
  }),
);

router.delete(
  '/:id',
  requireRole('admin', 'branch_manager'),
  asyncHandler(async (req, res) => {
    const customer = await Customer.findById(req.params.id);
    if (!customer) throw ApiError.notFound();
    const blocked = await findBlockingReference('ลูกค้า', [
      [Sale, { customerId: customer._id }, 'บิลขาย'],
      [Order, { customerId: customer._id }, 'ออเดอร์ออนไลน์'],
    ]);
    if (blocked) throw ApiError.conflict(blocked);
    await customer.deleteOne();
    await recordAudit({
      userId: req.authUser!.id,
      action: 'customer.delete',
      entityType: 'Customer',
      entityId: customer._id.toString(),
      before: customer.toObject(),
    });
    res.status(204).send();
  }),
);

export default router;
