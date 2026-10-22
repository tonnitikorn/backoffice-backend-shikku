import { Schema, model, Types } from 'mongoose';

export interface IBrand {
  _id: Types.ObjectId;
  name: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const brandSchema = new Schema<IBrand>(
  {
    name: { type: String, required: true, trim: true, unique: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const Brand = model<IBrand>('Brand', brandSchema);
