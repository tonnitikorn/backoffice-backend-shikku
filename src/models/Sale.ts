import { Schema, model, Types } from 'mongoose';
import { PAYMENT_STATUSES, PaymentStatus, SALE_CHANNELS, SaleChannel } from '../config/constants';

export type SaleStatus = 'completed' | 'voided';

export interface ISale {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  shiftSessionId: Types.ObjectId;
  channel: SaleChannel; // where the customer came from; POS can sell Grab/online orders during a shift
  customerId?: Types.ObjectId;
  subtotal: number;
  discountTotal: number;
  netTotal: number;
  paymentStatus: PaymentStatus;
  status: SaleStatus;
  cartPromotionId?: Types.ObjectId;
  couponId?: Types.ObjectId;
  soldBy: Types.ObjectId;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const saleSchema = new Schema<ISale>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    shiftSessionId: { type: Schema.Types.ObjectId, ref: 'ShiftSession', required: true },
    channel: { type: String, enum: SALE_CHANNELS, default: 'store' },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    subtotal: { type: Number, required: true },
    discountTotal: { type: Number, required: true },
    netTotal: { type: Number, required: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'paid' },
    status: { type: String, enum: ['completed', 'voided'], default: 'completed' },
    cartPromotionId: { type: Schema.Types.ObjectId, ref: 'Promotion' },
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon' },
    soldBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);

saleSchema.index({ branchId: 1, createdAt: -1 });
saleSchema.index({ shiftSessionId: 1 });

export const Sale = model<ISale>('Sale', saleSchema);
