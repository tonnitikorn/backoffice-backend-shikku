import { Schema, model, Types } from 'mongoose';

export type DailySalesClosedStatus = 'open' | 'partial' | 'closed';

/**
 * Materialized per-branch-per-day summary, recomputed as sales/refunds/
 * shifts happen. closedStatus === 'closed' means Daily Sale Closed (spec
 * B9: every shift of that branch-day is approved).
 */
export interface IDailySales {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  date: Date; // local midnight
  closedStatus: DailySalesClosedStatus;
  createdAt: Date;
  updatedAt: Date;
}

const dailySalesSchema = new Schema<IDailySales>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    date: { type: Date, required: true },
    closedStatus: { type: String, enum: ['open', 'partial', 'closed'], default: 'open' },
  },
  { timestamps: true },
);

dailySalesSchema.index({ branchId: 1, date: 1 }, { unique: true });

export const DailySales = model<IDailySales>('DailySales', dailySalesSchema);
