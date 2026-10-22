import { Schema, model, Types } from 'mongoose';

export interface IPurchaseItem {
  _id: Types.ObjectId;
  purchaseId: Types.ObjectId;
  skuId: Types.ObjectId;
  qty: number;
  unitCost: number; // satang, before allocation
  lot?: string;
  expiryDate?: Date;
  allocatedDiscount: number;
  allocatedShipping: number;
  finalUnitCost: number; // set at confirm time
  createdAt: Date;
  updatedAt: Date;
}

const purchaseItemSchema = new Schema<IPurchaseItem>(
  {
    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'ProductSku', required: true },
    qty: { type: Number, required: true, min: 1 },
    unitCost: { type: Number, required: true, min: 0 },
    lot: { type: String },
    expiryDate: { type: Date },
    allocatedDiscount: { type: Number, default: 0 },
    allocatedShipping: { type: Number, default: 0 },
    finalUnitCost: { type: Number, default: 0 },
  },
  { timestamps: true },
);

purchaseItemSchema.index({ purchaseId: 1 });

export const PurchaseItem = model<IPurchaseItem>('PurchaseItem', purchaseItemSchema);
