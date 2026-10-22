import { Types } from 'mongoose';
import { CashMovement } from '../models/CashMovement';
import { Expense } from '../models/Expense';
import { ShiftSession } from '../models/ShiftSession';
import { CashMovementType } from '../config/constants';
import { ApiError } from '../utils/ApiError';
import { recordAudit } from './auditService';

const REVERSE_TYPE: Record<CashMovementType, CashMovementType> = {
  cash_out: 'cash_in',
  cash_in: 'cash_out',
  deposit: 'cash_in',
};

export async function createCashMovement(input: {
  shiftSessionId: string;
  type: CashMovementType;
  amount: number;
  reason: string;
  performedBy: string;
  receiptImage?: string;
  createExpenseCategory?: string;
}) {
  const shift = await ShiftSession.findById(input.shiftSessionId);
  if (!shift) throw ApiError.notFound('Shift session not found');
  if (shift.status !== 'open') throw ApiError.conflict('Cash movements can only be recorded on an open shift');

  let linkedExpenseId: Types.ObjectId | undefined;
  if (input.type === 'cash_out' && input.createExpenseCategory) {
    const expense = await Expense.create({
      branchId: shift.branchId,
      date: new Date(),
      category: input.createExpenseCategory,
      description: input.reason,
      amount: input.amount,
      recordedBy: input.performedBy,
    });
    linkedExpenseId = expense._id;
  }

  const movement = await CashMovement.create({
    shiftSessionId: shift._id,
    branchId: shift.branchId,
    type: input.type,
    amount: input.amount,
    reason: input.reason,
    performedBy: input.performedBy,
    receiptImage: input.receiptImage,
    linkedExpenseId,
  });

  if (linkedExpenseId) {
    await Expense.findByIdAndUpdate(linkedExpenseId, { $set: { linkedCashMovementId: movement._id } });
  }

  return movement;
}

/** Only a Branch Manager/Admin can correct a cash movement, via reversal — never edit/delete (spec B9). */
export async function reverseCashMovement(originalId: string, performedBy: string, reason: string) {
  const original = await CashMovement.findById(originalId);
  if (!original) throw ApiError.notFound('Cash movement not found');

  const shift = await ShiftSession.findById(original.shiftSessionId);
  if (!shift || shift.status !== 'open') throw ApiError.conflict('Can only reverse a movement on a still-open shift');

  const reversal = await CashMovement.create({
    shiftSessionId: original.shiftSessionId,
    branchId: original.branchId,
    type: REVERSE_TYPE[original.type],
    amount: original.amount,
    reason: `Reversal: ${reason}`,
    performedBy,
    reversalOfId: original._id,
  });

  await recordAudit({
    userId: performedBy,
    branchId: original.branchId,
    action: 'cash_movement.reverse',
    entityType: 'CashMovement',
    entityId: original._id.toString(),
    after: reversal.toObject(),
  });

  return reversal;
}
