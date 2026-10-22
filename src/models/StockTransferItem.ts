import { Schema, model, Types } from 'mongoose';

export type DiscrepancyResolution = 'pending' | 'damaged' | 'lost' | 'admin_confirmed';

export interface IStockTransferItem {
  _id: Types.ObjectId;
  transferId: Types.ObjectId;
  skuId: Types.ObjectId;
  qtySent: number;
  qtyReceived?: number;
  lot?: string;
  expiryDate?: Date;
  costAtTransfer: number; // satang, snapshot so no profit/loss is created by the move
  discrepancyQty: number;
  discrepancyResolution?: DiscrepancyResolution;
  discrepancyReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const stockTransferItemSchema = new Schema<IStockTransferItem>(
  {
    transferId: { type: Schema.Types.ObjectId, ref: 'StockTransfer', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'ProductSku', required: true },
    qtySent: { type: Number, required: true, min: 1 },
    qtyReceived: { type: Number },
    lot: { type: String },
    expiryDate: { type: Date },
    costAtTransfer: { type: Number, required: true },
    discrepancyQty: { type: Number, default: 0 },
    discrepancyResolution: { type: String, enum: ['pending', 'damaged', 'lost', 'admin_confirmed'] },
    discrepancyReason: { type: String },
  },
  { timestamps: true },
);

stockTransferItemSchema.index({ transferId: 1 });

export const StockTransferItem = model<IStockTransferItem>('StockTransferItem', stockTransferItemSchema);
