import { Schema, model, Types } from 'mongoose';
import { PAYMENT_METHODS, PaymentMethod } from '../config/constants';

export type PaymentParentType = 'Sale' | 'Order';

export interface IPayment {
  _id: Types.ObjectId;
  parentType: PaymentParentType;
  parentId: Types.ObjectId;
  method: PaymentMethod;
  amount: number; // satang, positive for a payment, negative for a refund line
  referenceNo?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    parentType: { type: String, enum: ['Sale', 'Order'], required: true },
    parentId: { type: Schema.Types.ObjectId, required: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    amount: { type: Number, required: true },
    referenceNo: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

paymentSchema.index({ parentType: 1, parentId: 1 });

export const Payment = model<IPayment>('Payment', paymentSchema);
