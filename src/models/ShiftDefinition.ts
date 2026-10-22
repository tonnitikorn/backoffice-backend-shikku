import { Schema, model, Types } from 'mongoose';

export interface IShiftDefinition {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  name: string;
  startTime: string; // "HH:mm"
  endTime: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const shiftDefinitionSchema = new Schema<IShiftDefinition>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    name: { type: String, required: true, trim: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const ShiftDefinition = model<IShiftDefinition>('ShiftDefinition', shiftDefinitionSchema);
