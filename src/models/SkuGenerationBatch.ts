import { Schema, model, Types } from 'mongoose';

export interface IPowerRange {
  from: number;
  to: number;
  step: number;
}

export interface ISkuGenerationBatch {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  variantId?: Types.ObjectId;
  ranges: IPowerRange[];
  codeFormatUsed: string;
  requestedCount: number;
  createdCount: number;
  skippedDuplicateCount: number;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const powerRangeSchema = new Schema<IPowerRange>(
  { from: Number, to: Number, step: Number },
  { _id: false },
);

const skuGenerationBatchSchema = new Schema<ISkuGenerationBatch>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },
    ranges: [powerRangeSchema],
    codeFormatUsed: { type: String, required: true },
    requestedCount: { type: Number, required: true },
    createdCount: { type: Number, required: true },
    skippedDuplicateCount: { type: Number, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const SkuGenerationBatch = model<ISkuGenerationBatch>('SkuGenerationBatch', skuGenerationBatchSchema);
