import { Schema, model, Types } from 'mongoose';

export type PurchaseStatus = 'draft' | 'confirmed';

export interface IPurchase {
  _id: Types.ObjectId;
  supplierId: Types.ObjectId;
  branchId: Types.ObjectId;
  invoiceNo?: string;
  purchaseDate: Date;
  status: PurchaseStatus;
  subtotal: number; // satang, sum of unitCost*qty before discount/shipping/vat
  discountTotal: number;
  vat: number;
  shippingCost: number;
  totalCost: number; // subtotal - discountTotal + shippingCost + vat
  createdBy: Types.ObjectId;
  confirmedBy?: Types.ObjectId;
  confirmedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const purchaseSchema = new Schema<IPurchase>(
  {
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    invoiceNo: { type: String, trim: true },
    purchaseDate: { type: Date, required: true },
    status: { type: String, enum: ['draft', 'confirmed'], default: 'draft' },
    subtotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    vat: { type: Number, default: 0 },
    shippingCost: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    confirmedAt: { type: Date },
  },
  { timestamps: true },
);

export const Purchase = model<IPurchase>('Purchase', purchaseSchema);
