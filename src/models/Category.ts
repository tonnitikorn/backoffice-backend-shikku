import { Schema, model, Types } from 'mongoose';
import { PRODUCT_TYPES, ProductType } from '../config/constants';

export interface ICategory {
  _id: Types.ObjectId;
  name: string;
  appliesTo: ProductType;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<ICategory>(
  {
    name: { type: String, required: true, trim: true },
    appliesTo: { type: String, enum: PRODUCT_TYPES, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Category = model<ICategory>('Category', categorySchema);
