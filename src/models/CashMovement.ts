import { Schema, model, Types } from 'mongoose';
import { CASH_MOVEMENT_TYPES, CashMovementType } from '../config/constants';

export interface ICashMovement {
  _id: Types.ObjectId;
  shiftSessionId: Types.ObjectId;
  branchId: Types.ObjectId;
  type: CashMovementType;
  amount: number; // satang, always positive; direction implied by type
  reason: string;
  performedBy: Types.ObjectId;
  receiptImage?: string;
  linkedExpenseId?: Types.ObjectId;
  reversalOfId?: Types.ObjectId;
  createdAt: Date;
}

const cashMovementSchema = new Schema<ICashMovement>(
  {
    shiftSessionId: { type: Schema.Types.ObjectId, ref: 'ShiftSession', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    type: { type: String, enum: CASH_MOVEMENT_TYPES, required: true },
    amount: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    receiptImage: { type: String },
    linkedExpenseId: { type: Schema.Types.ObjectId, ref: 'Expense' },
    reversalOfId: { type: Schema.Types.ObjectId, ref: 'CashMovement' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

cashMovementSchema.index({ shiftSessionId: 1 });

export const CashMovement = model<ICashMovement>('CashMovement', cashMovementSchema);
