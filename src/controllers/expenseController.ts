import { z } from 'zod';
import { Expense } from '../models/Expense';
import { EXPENSE_CATEGORIES } from '../config/constants';
import { buildCrudRouter } from '../utils/crudFactory';
import { ApiError } from '../utils/ApiError';

const createSchema = z.object({
  branchId: z.string(),
  date: z.string(),
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().min(1),
  amount: z.number().positive(),
  vat: z.number().min(0).optional(),
  attachment: z.string().optional(),
});

export default buildCrudRouter({
  model: Expense,
  createSchema,
  updateSchema: createSchema.omit({ branchId: true }).partial(),
  writeRoles: ['admin', 'branch_manager'],
  searchFields: ['description'],
  filterFields: ['branchId', 'category'],
  sort: { date: -1, createdAt: -1 },
  beforeCreate: (req, body) => {
    const branchId = body.branchId as string;
    if (req.authUser!.role !== 'admin' && !req.authUser!.branchIds.includes(branchId)) {
      throw ApiError.forbidden('You do not have access to this branch');
    }
    return { ...body, recordedBy: req.authUser!.id };
  },
  deleteGuard: async (expense) =>
    expense.linkedCashMovementId ? 'รายการนี้ผูกกับการเบิกเงินสดในกะ ลบไม่ได้ — ให้กลับรายการเงินสดแทน' : null,
});
