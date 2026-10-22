import { Schema, model, Types } from 'mongoose';
import { REFUND_TYPES, RefundType, REFUND_STATUSES, RefundStatus, PAYMENT_METHODS, PaymentMethod } from '../config/constants';

export type RefundOriginalType = 'Sale' | 'Order';

export interface IRefundChannelLine {
  method: PaymentMethod;
  amount: number; // satang
}

export interface IRefund {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  shiftSessionId?: Types.ObjectId; // the shift the refund is recorded against (spec B10)
  originalType: RefundOriginalType;
  originalId: Types.ObjectId;
  type: RefundType;
  reason: string;
  status: RefundStatus;
  refundChannelLines: IRefundChannelLine[];
  totalRefundAmount: number;
  exchangeNewSaleId?: Types.ObjectId;
  requestedBy: Types.ObjectId;
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const refundChannelLineSchema = new Schema<IRefundChannelLine>(
  { method: { type: String, enum: PAYMENT_METHODS, required: true }, amount: { type: Number, required: true } },
  { _id: false },
);

const refundSchema = new Schema<IRefund>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    shiftSessionId: { type: Schema.Types.ObjectId, ref: 'ShiftSession' },
    originalType: { type: String, enum: ['Sale', 'Order'], required: true },
    originalId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: REFUND_TYPES, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: REFUND_STATUSES, default: 'pending' },
    refundChannelLines: [refundChannelLineSchema],
    totalRefundAmount: { type: Number, required: true, default: 0 },
    exchangeNewSaleId: { type: Schema.Types.ObjectId, ref: 'Sale' },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
  },
  { timestamps: true },
);

refundSchema.index({ originalType: 1, originalId: 1 });
refundSchema.index({ shiftSessionId: 1 });

export const Refund = model<IRefund>('Refund', refundSchema);
