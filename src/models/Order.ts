import { Schema, model, Types } from 'mongoose';
import { SALE_CHANNELS, SaleChannel, ORDER_STATUSES, OrderStatus, PAYMENT_STATUSES, PaymentStatus } from '../config/constants';

export interface IOrderStatusHistoryEntry {
  status: OrderStatus;
  at: Date;
  by: Types.ObjectId;
  note?: string;
}

export interface IOrder {
  _id: Types.ObjectId;
  branchId: Types.ObjectId; // source branch that fulfills / cuts stock
  shiftSessionId?: Types.ObjectId; // the branch's shift that was open when the order was logged; it shows up in that shift's summary
  customerId?: Types.ObjectId;
  channel: SaleChannel;
  subtotal: number;
  discountTotal: number;
  netTotal: number;
  shippingMethod?: string; // 'shipping' | 'grab_express' | ...
  shippingAddress?: string;
  trackingNumber?: string;
  paymentStatus: PaymentStatus;
  orderStatus: OrderStatus;
  statusHistory: IOrderStatusHistoryEntry[];
  cartPromotionId?: Types.ObjectId;
  couponId?: Types.ObjectId;
  createdBy: Types.ObjectId; // shop owner logging the chat order
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const statusHistorySchema = new Schema<IOrderStatusHistoryEntry>(
  {
    status: { type: String, enum: ORDER_STATUSES, required: true },
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    note: { type: String },
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    shiftSessionId: { type: Schema.Types.ObjectId, ref: 'ShiftSession' },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    channel: { type: String, enum: SALE_CHANNELS, required: true },
    subtotal: { type: Number, required: true },
    discountTotal: { type: Number, required: true },
    netTotal: { type: Number, required: true },
    shippingMethod: { type: String },
    shippingAddress: { type: String },
    trackingNumber: { type: String },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid' },
    orderStatus: { type: String, enum: ORDER_STATUSES, default: 'confirmed' },
    statusHistory: [statusHistorySchema],
    cartPromotionId: { type: Schema.Types.ObjectId, ref: 'Promotion' },
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);

orderSchema.index({ branchId: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1 });
orderSchema.index({ shiftSessionId: 1 });

export const Order = model<IOrder>('Order', orderSchema);
