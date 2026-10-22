import { Schema, model, Types } from 'mongoose';

/** 'awaiting' = no API key: the photo waits for a result pasted back from the Claude app. */
export type StockPhotoScanStatus = 'awaiting' | 'processing' | 'ready' | 'failed';

/** One vial group the AI read off the tray photo, mapped to a SKU when possible. */
export interface IStockPhotoScanRow {
  model: string;
  color: string;
  power: number | null;
  vials: number;
  confidence: 'high' | 'low';
  note?: string;
  productId?: Types.ObjectId;
  variantId?: Types.ObjectId;
  skuId?: Types.ObjectId;
  matchError?: string;
}

/** A cap the AI picked as a clear example for a model/color, as a fraction of the image (0–1). */
export interface IStockPhotoScanSample {
  model: string;
  color: string;
  box: { x: number; y: number; w: number; h: number };
  productId?: Types.ObjectId;
  variantId?: Types.ObjectId;
}

export interface IStockPhotoScan {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  imageUrl: string;
  status: StockPhotoScanStatus;
  rows: IStockPhotoScanRow[];
  samples: IStockPhotoScanSample[];
  unreadable: number;
  error?: string;
  modelUsed?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const rowSchema = new Schema<IStockPhotoScanRow>(
  {
    model: String,
    color: String,
    power: { type: Number, default: null },
    vials: Number,
    confidence: { type: String, enum: ['high', 'low'] },
    note: String,
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },
    skuId: { type: Schema.Types.ObjectId, ref: 'ProductSku' },
    matchError: String,
  },
  { _id: false },
);

const stockPhotoScanSchema = new Schema<IStockPhotoScan>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    imageUrl: { type: String, required: true },
    status: { type: String, enum: ['awaiting', 'processing', 'ready', 'failed'], default: 'processing' },
    rows: [rowSchema],
    samples: [
      {
        _id: false,
        model: String,
        color: String,
        box: { x: Number, y: Number, w: Number, h: Number },
        productId: { type: Schema.Types.ObjectId, ref: 'Product' },
        variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },
      },
    ],
    unreadable: { type: Number, default: 0 },
    error: String,
    modelUsed: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

stockPhotoScanSchema.index({ branchId: 1, createdAt: -1 });

export const StockPhotoScan = model<IStockPhotoScan>('StockPhotoScan', stockPhotoScanSchema);
