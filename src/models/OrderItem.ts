import { Schema, model, Types } from 'mongoose';

export interface IOrderItem {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  skuId: Types.ObjectId;
  qty: number;
  unitPriceAtSale: number;
  unitCostAtSale: number;
  promotionId?: Types.ObjectId;
  discountApplied: number;
  lineTotal: number;
  refundedQty: number;
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'ProductSku', required: true },
    qty: { type: Number, required: true },
    unitPriceAtSale: { type: Number, required: true },
    unitCostAtSale: { type: Number, required: true },
    promotionId: { type: Schema.Types.ObjectId, ref: 'Promotion' },
    discountApplied: { type: Number, default: 0 },
    lineTotal: { type: Number, required: true },
    refundedQty: { type: Number, default: 0 },
  },
  { timestamps: true },
);

orderItemSchema.index({ orderId: 1 });

export const OrderItem = model<IOrderItem>('OrderItem', orderItemSchema);
