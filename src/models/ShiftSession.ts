import { Schema, model, Types } from 'mongoose';
import { SHIFT_SESSION_STATUSES, ShiftSessionStatus } from '../config/constants';

export interface IShiftSession {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  userId: Types.ObjectId; // opener; owns the cash variance (spec B9)
  scheduleId?: Types.ObjectId;
  shiftDefinitionId?: Types.ObjectId;
  openedAt: Date;
  openingFloat: number; // satang, counted at open
  openingFloatExpected: number;
  openingFloatVarianceReason?: string;
  openedOutsideSchedule: boolean;
  openApprovedBy?: Types.ObjectId;

  closedAt?: Date;
  status: ShiftSessionStatus;

  systemCashExpected?: number;
  systemTransferExpected?: number;
  closingCashCounted?: number;
  closingTransferCounted?: number;
  cashVariance?: number;
  varianceReason?: string;
  carryForwardFloat?: number;
  cashHandedIn?: number;

  approvedBy?: Types.ObjectId;
  approvedAt?: Date;
  rejectedReason?: string;

  reopenedBy?: Types.ObjectId;
  reopenedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const shiftSessionSchema = new Schema<IShiftSession>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    scheduleId: { type: Schema.Types.ObjectId, ref: 'ShiftSchedule' },
    shiftDefinitionId: { type: Schema.Types.ObjectId, ref: 'ShiftDefinition' },
    openedAt: { type: Date, required: true },
    openingFloat: { type: Number, required: true },
    openingFloatExpected: { type: Number, required: true },
    openingFloatVarianceReason: { type: String },
    openedOutsideSchedule: { type: Boolean, default: false },
    openApprovedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    closedAt: { type: Date },
    status: { type: String, enum: SHIFT_SESSION_STATUSES, default: 'open' },

    systemCashExpected: { type: Number },
    systemTransferExpected: { type: Number },
    closingCashCounted: { type: Number },
    closingTransferCounted: { type: Number },
    cashVariance: { type: Number },
    varianceReason: { type: String },
    carryForwardFloat: { type: Number },
    cashHandedIn: { type: Number },

    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    rejectedReason: { type: String },

    reopenedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reopenedAt: { type: Date },
  },
  { timestamps: true },
);

shiftSessionSchema.index({ branchId: 1, status: 1 });
shiftSessionSchema.index({ userId: 1, status: 1 });

export const ShiftSession = model<IShiftSession>('ShiftSession', shiftSessionSchema);
