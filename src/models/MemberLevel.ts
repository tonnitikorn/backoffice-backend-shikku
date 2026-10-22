import { Schema, model, Types } from 'mongoose';

export interface IMemberLevel {
  _id: Types.ObjectId;
  name: string;
  thresholdSpend: number; // satang, cumulative spend to reach this level
  benefitsDescription?: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const memberLevelSchema = new Schema<IMemberLevel>(
  {
    name: { type: String, required: true, trim: true },
    thresholdSpend: { type: Number, default: 0 },
    benefitsDescription: { type: String },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const MemberLevel = model<IMemberLevel>('MemberLevel', memberLevelSchema);
