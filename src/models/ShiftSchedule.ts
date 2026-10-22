import { Schema, model, Types } from 'mongoose';

export type ShiftScheduleStatus = 'draft' | 'published';

export interface IShiftSchedule {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  userId: Types.ObjectId;
  shiftDefinitionId: Types.ObjectId;
  date: Date; // normalized to local midnight
  status: ShiftScheduleStatus;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const shiftScheduleSchema = new Schema<IShiftSchedule>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    shiftDefinitionId: { type: Schema.Types.ObjectId, ref: 'ShiftDefinition', required: true },
    date: { type: Date, required: true },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    publishedAt: { type: Date },
  },
  { timestamps: true },
);

shiftScheduleSchema.index({ branchId: 1, date: 1 });
shiftScheduleSchema.index({ userId: 1, date: 1 });

export const ShiftSchedule = model<IShiftSchedule>('ShiftSchedule', shiftScheduleSchema);
