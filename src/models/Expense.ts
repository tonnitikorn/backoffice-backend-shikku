import { Schema, model, Types } from 'mongoose';
import { EXPENSE_CATEGORIES, ExpenseCategory } from '../config/constants';

export interface IExpense {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  date: Date;
  category: ExpenseCategory;
  description: string;
  amount: number; // satang
  vat?: number;
  recordedBy: Types.ObjectId;
  attachment?: string;
  linkedCashMovementId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const expenseSchema = new Schema<IExpense>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    date: { type: Date, required: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    description: { type: String, required: true },
    amount: { type: Number, required: true },
    vat: { type: Number, default: 0 },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    attachment: { type: String },
    linkedCashMovementId: { type: Schema.Types.ObjectId, ref: 'CashMovement' },
  },
  { timestamps: true },
);

expenseSchema.index({ branchId: 1, date: -1 });

export const Expense = model<IExpense>('Expense', expenseSchema);
