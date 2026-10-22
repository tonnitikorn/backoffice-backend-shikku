import { Schema, model, Types } from 'mongoose';

export interface ICustomer {
  _id: Types.ObjectId;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  birthday?: Date;
  lineUserId?: string;
  memberLevelId?: Types.ObjectId;
  points: number;
  totalSpend: number; // satang, aggregated across all branches/channels
  createdAt: Date;
  updatedAt: Date;
}

const customerSchema = new Schema<ICustomer>(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true, index: true },
    email: { type: String, trim: true },
    address: { type: String },
    birthday: { type: Date },
    lineUserId: { type: String },
    memberLevelId: { type: Schema.Types.ObjectId, ref: 'MemberLevel' },
    points: { type: Number, default: 0 },
    totalSpend: { type: Number, default: 0 },
  },
  { timestamps: true },
);

customerSchema.index({ name: 'text', phone: 'text', email: 'text' });

export const Customer = model<ICustomer>('Customer', customerSchema);
