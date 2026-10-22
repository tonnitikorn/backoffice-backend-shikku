import { Schema, model, Types } from 'mongoose';
import { UNIT_OF_MEASURE, UnitOfMeasure } from '../config/constants';

export interface IProductSku {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  variantId?: Types.ObjectId;
  skuCode: string;
  barcode: string;
  power?: number; // ค่าสายตา (diopter), only for contact lenses
  priceRegular: number; // satang
  priceMember?: number;
  priceSpecial?: number;
  cost: number; // satang
  minStockLevel: number;
  unitOfMeasure: UnitOfMeasure;
  active: boolean;
  generationBatchId?: Types.ObjectId;
  hasHistory: boolean; // set true once any sale/stock movement references it; blocks deletion
  createdAt: Date;
  updatedAt: Date;
}

const productSkuSchema = new Schema<IProductSku>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },
    skuCode: { type: String, required: true, unique: true, trim: true, uppercase: true },
    barcode: { type: String, required: true, unique: true, trim: true },
    power: { type: Number },
    priceRegular: { type: Number, required: true, default: 0 },
    priceMember: { type: Number },
    priceSpecial: { type: Number },
    cost: { type: Number, required: true, default: 0 },
    minStockLevel: { type: Number, default: 0 },
    unitOfMeasure: { type: String, enum: UNIT_OF_MEASURE, default: 'piece' },
    active: { type: Boolean, default: true },
    generationBatchId: { type: Schema.Types.ObjectId, ref: 'SkuGenerationBatch' },
    hasHistory: { type: Boolean, default: false },
  },
  { timestamps: true },
);

productSkuSchema.index({ productId: 1 });
productSkuSchema.index({ skuCode: 'text', barcode: 'text' });

export const ProductSku = model<IProductSku>('ProductSku', productSkuSchema);
