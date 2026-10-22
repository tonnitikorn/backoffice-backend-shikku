import { Schema, model, Types } from 'mongoose';

export interface ICoupon {
  _id: Types.ObjectId;
  code: string;
  promotionId: Types.ObjectId;
  usageLimit?: number; // undefined = unlimited
  usedCount: number;
  perCustomerLimit?: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new Schema<ICoupon>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    promotionId: { type: Schema.Types.ObjectId, ref: 'Promotion', required: true },
    usageLimit: { type: Number },
    usedCount: { type: Number, default: 0 },
    perCustomerLimit: { type: Number },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Coupon = model<ICoupon>('Coupon', couponSchema);
