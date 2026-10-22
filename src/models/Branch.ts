import { Schema, model, Types } from 'mongoose';

export interface IBranch {
  _id: Types.ObjectId;
  code: string;
  name: string;
  address?: string;
  phone?: string;
  active: boolean;
  isDefaultOnlineBranch: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const branchSchema = new Schema<IBranch>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    active: { type: Boolean, default: true },
    isDefaultOnlineBranch: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const Branch = model<IBranch>('Branch', branchSchema);
