import { Schema, model, Types } from 'mongoose';
import { ITEM_CONDITIONS, ItemCondition, STOCK_DESTINATIONS, StockDestination } from '../config/constants';

export interface IRefundItem {
  _id: Types.ObjectId;
  refundId: Types.ObjectId;
  originalItemId: Types.ObjectId; // SaleItem or OrderItem id
  skuId: Types.ObjectId;
  qty: number;
  unitRefundAmount: number; // satang, per unit, after proportional discount
  condition: ItemCondition;
  stockDestination: StockDestination;
  lot?: string;
  expiryDate?: Date;
  createdAt: Date;
}

const refundItemSchema = new Schema<IRefundItem>(
  {
    refundId: { type: Schema.Types.ObjectId, ref: 'Refund', required: true },
    originalItemId: { type: Schema.Types.ObjectId, required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'ProductSku', required: true },
    qty: { type: Number, required: true },
    unitRefundAmount: { type: Number, required: true },
    condition: { type: String, enum: ITEM_CONDITIONS, required: true },
    stockDestination: { type: String, enum: STOCK_DESTINATIONS, required: true },
    lot: { type: String },
    expiryDate: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

refundItemSchema.index({ refundId: 1 });

export const RefundItem = model<IRefundItem>('RefundItem', refundItemSchema);
