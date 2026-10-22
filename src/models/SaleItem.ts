import { Schema, model, Types } from 'mongoose';

export interface ISaleItem {
  _id: Types.ObjectId;
  saleId: Types.ObjectId;
  skuId: Types.ObjectId;
  qty: number;
  unitPriceAtSale: number; // satang, price actually charged (post promotion)
  unitCostAtSale: number; // satang, snapshot of sku.cost at time of sale
  promotionId?: Types.ObjectId;
  discountApplied: number; // (tiered price - final price) * qty
  priceOverrideReason?: string; // set when the cashier typed the price by hand (0 = giveaway)
  lineTotal: number;
  oversoldQty?: number; // units sold beyond the system count (cashier confirmed they were on hand)
  refundedQty: number; // running total already refunded against this line
  createdAt: Date;
  updatedAt: Date;
}

const saleItemSchema = new Schema<ISaleItem>(
  {
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'ProductSku', required: true },
    qty: { type: Number, required: true },
    unitPriceAtSale: { type: Number, required: true },
    unitCostAtSale: { type: Number, required: true },
    promotionId: { type: Schema.Types.ObjectId, ref: 'Promotion' },
    discountApplied: { type: Number, default: 0 },
    priceOverrideReason: { type: String },
    lineTotal: { type: Number, required: true },
    oversoldQty: { type: Number },
    refundedQty: { type: Number, default: 0 },
  },
  { timestamps: true },
);

saleItemSchema.index({ saleId: 1 });

export const SaleItem = model<ISaleItem>('SaleItem', saleItemSchema);
