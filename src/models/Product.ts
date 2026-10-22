import { Schema, model, Types } from 'mongoose';
import { PRODUCT_TYPES, ProductType, UNIT_OF_MEASURE, UnitOfMeasure } from '../config/constants';

export interface IProduct {
  _id: Types.ObjectId;
  name: string;
  shortCode: string; // used to build generated SKU codes, e.g. "ACM"
  brandId?: Types.ObjectId;
  categoryId?: Types.ObjectId;
  type: ProductType;
  seriesName?: string;
  dia?: number;
  bc?: number;
  wearDurationDays?: number;
  unitOfMeasure: UnitOfMeasure;
  defaultPriceRegular: number; // satang; inherited by generated SKUs (spec B5) — also the price for power 0.00 / no power
  defaultPowerPriceRegular?: number; // satang; price for SKUs with a non-zero power, when it differs from plano
  defaultCost: number;
  defaultMinStockLevel: number;
  description?: string;
  images: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, trim: true },
    shortCode: { type: String, required: true, trim: true, uppercase: true },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand' },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
    type: { type: String, enum: PRODUCT_TYPES, required: true },
    seriesName: { type: String, trim: true },
    dia: { type: Number },
    bc: { type: Number },
    wearDurationDays: { type: Number },
    unitOfMeasure: { type: String, enum: UNIT_OF_MEASURE, default: 'piece' },
    defaultPriceRegular: { type: Number, default: 0 },
    defaultPowerPriceRegular: { type: Number },
    defaultCost: { type: Number, default: 0 },
    defaultMinStockLevel: { type: Number, default: 0 },
    description: { type: String },
    images: [{ type: String }],
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

productSchema.index({ name: 'text', seriesName: 'text' });

export const Product = model<IProduct>('Product', productSchema);

/** Plano (0.00) and no-power SKUs use the regular price; any other power uses the power price when one is set. */
export function priceForPower(product: Pick<IProduct, 'defaultPriceRegular' | 'defaultPowerPriceRegular'>, power: number | undefined | null): number {
  const hasPower = power !== undefined && power !== null && power !== 0;
  return hasPower && product.defaultPowerPriceRegular != null ? product.defaultPowerPriceRegular : product.defaultPriceRegular;
}
