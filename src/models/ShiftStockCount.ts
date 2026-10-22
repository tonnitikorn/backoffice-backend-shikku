import { Schema, model, Types } from 'mongoose';

export type StockCountPhase = 'open' | 'close';

export interface IShiftStockCountLine {
  groupId: Types.ObjectId;
  groupName: string;
  countedQty: number;
  systemQty: number; // what the ledger said at the moment of counting
}

/** Physical stock count per group, taken when a shift opens ("Stock ก่อนขาย") and closes ("Stock หลังขาย"). */
export interface IShiftStockCount {
  _id: Types.ObjectId;
  shiftSessionId: Types.ObjectId;
  branchId: Types.ObjectId;
  phase: StockCountPhase;
  lines: IShiftStockCountLine[];
  note?: string;
  countedBy: Types.ObjectId;
  countedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const lineSchema = new Schema<IShiftStockCountLine>(
  {
    groupId: { type: Schema.Types.ObjectId, ref: 'StockCountGroup', required: true },
    groupName: { type: String, required: true },
    countedQty: { type: Number, required: true },
    systemQty: { type: Number, required: true },
  },
  { _id: false },
);

const shiftStockCountSchema = new Schema<IShiftStockCount>(
  {
    shiftSessionId: { type: Schema.Types.ObjectId, ref: 'ShiftSession', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    phase: { type: String, enum: ['open', 'close'], required: true },
    lines: [lineSchema],
    note: { type: String },
    countedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    countedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

shiftStockCountSchema.index({ shiftSessionId: 1, phase: 1 }, { unique: true });

export const ShiftStockCount = model<IShiftStockCount>('ShiftStockCount', shiftStockCountSchema);
