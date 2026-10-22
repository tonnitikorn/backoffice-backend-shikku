import { Schema, model, Types } from 'mongoose';

export interface IProductVariant {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  colorName?: string;
  colorCode?: string; // short code embedded in generated SKU codes, e.g. "BRO" -> MO850-BRO-M0325
  images: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productVariantSchema = new Schema<IProductVariant>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    colorName: { type: String, trim: true },
    colorCode: { type: String, trim: true, uppercase: true },
    images: [{ type: String }],
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

productVariantSchema.index({ productId: 1 });

export const ProductVariant = model<IProductVariant>('ProductVariant', productVariantSchema);
