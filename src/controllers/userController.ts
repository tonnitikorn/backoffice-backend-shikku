import { Router } from 'express';
import { z } from 'zod';
import { User } from '../models/User';
import { ROLES } from '../config/constants';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { hashPassword, sanitizeUser } from '../services/authService';
import { recordAudit } from '../services/auditService';
import { findBlockingReference } from '../services/referenceGuard';
import { Sale } from '../models/Sale';
import { Order } from '../models/Order';
import { ShiftSession } from '../models/ShiftSession';
import { ShiftSchedule } from '../models/ShiftSchedule';
import { InventoryTransaction } from '../models/InventoryTransaction';
import { Purchase } from '../models/Purchase';
import { Refund } from '../models/Refund';
import { StockTransfer } from '../models/StockTransfer';
import { Expense } from '../models/Expense';
import { CashMovement } from '../models/CashMovement';

const router = Router();
router.use(requireAuth, requireActiveUser, requireRole('admin'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    // Not populated: sanitizeUser serialises branchIds as plain id strings.
    const users = await User.find().sort({ createdAt: 1 });
    res.json({ items: users.map(sanitizeUser) });
  }),
);

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(ROLES),
  branchIds: z.array(z.string()).default([]),
  lineUserId: z.string().optional(),
});

router.post(
  '/',
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const { password, ...rest } = req.body;
    const passwordHash = await hashPassword(password);
    const user = await User.create({ ...rest, passwordHash });
    await recordAudit({
      userId: req.authUser!.id,
      action: 'user.create',
      entityType: 'User',
      entityId: user._id.toString(),
      after: sanitizeUser(user),
    });
    res.status(201).json({ item: sanitizeUser(user) });
  }),
);

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(ROLES).optional(),
  branchIds: z.array(z.string()).optional(),
  lineUserId: z.string().optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

router.patch(
  '/:id',
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const before = await User.findById(req.params.id);
    if (!before) throw ApiError.notFound();
    if (req.params.id === req.authUser!.id && (req.body.active === false || (req.body.role && req.body.role !== 'admin'))) {
      throw ApiError.badRequest('ไม่สามารถปิดใช้งานหรือลดสิทธิ์บัญชีของตัวเองได้');
    }

    const { password, ...rest } = req.body;
    const setFields: Record<string, unknown> = { ...rest };
    if (password) setFields.passwordHash = await hashPassword(password);

    const update: Record<string, unknown> = { $set: setFields };
    if (rest.role !== undefined || rest.branchIds !== undefined || rest.active === false) {
      update.$inc = { refreshTokenVersion: 1 }; // force re-login when role/branch/active changes
    }

    const after = await User.findByIdAndUpdate(req.params.id, update, { new: true });

    await recordAudit({
      userId: req.authUser!.id,
      action: 'user.update',
      entityType: 'User',
      entityId: req.params.id,
      before: sanitizeUser(before),
      after: sanitizeUser(after!),
    });

    res.json({ item: sanitizeUser(after!) });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (req.params.id === req.authUser!.id) throw ApiError.badRequest('ไม่สามารถลบบัญชีของตัวเองได้');
    const user = await User.findById(req.params.id);
    if (!user) throw ApiError.notFound();

    const blocked = await findBlockingReference('ผู้ใช้งาน', [
      [Sale, { soldBy: user._id }, 'บิลขาย'],
      [Order, { createdBy: user._id }, 'ออเดอร์ออนไลน์'],
      [ShiftSession, { userId: user._id }, 'กะการขาย'],
      [InventoryTransaction, { performedBy: user._id }, 'ประวัติสต๊อก'],
      [Purchase, { createdBy: user._id }, 'ใบรับสินค้า'],
      [Refund, { requestedBy: user._id }, 'คำขอคืนสินค้า'],
      [StockTransfer, { sentBy: user._id }, 'การโอนสต๊อก'],
      [Expense, { recordedBy: user._id }, 'ค่าใช้จ่าย'],
      [CashMovement, { performedBy: user._id }, 'รายการเงินสด'],
    ]);
    if (blocked) throw ApiError.conflict(blocked);

    await ShiftSchedule.deleteMany({ userId: user._id });
    await user.deleteOne();
    await recordAudit({
      userId: req.authUser!.id,
      action: 'user.delete',
      entityType: 'User',
      entityId: user._id.toString(),
      before: sanitizeUser(user),
    });
    res.status(204).send();
  }),
);

export default router;
