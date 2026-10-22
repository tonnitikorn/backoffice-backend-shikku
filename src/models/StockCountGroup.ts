import { Schema, model, Types } from 'mongoose';

export const POWER_FILTERS = ['any', 'plano', 'non_plano'] as const;
export type PowerFilter = (typeof POWER_FILTERS)[number];

/**
 * A line on the paper stock sheet staff count before/after every shift
 * (e.g. "สายตาปกติ 99฿" = every 99฿ lens model at power 0.00). Groups are
 * shared by all branches; a SKU belongs to the first matching group by sortOrder.
 */
export interface IStockCountGroup {
  _id: Types.ObjectId;
  name: string;
  sortOrder: number;
  productIds: Types.ObjectId[];
  powerFilter: PowerFilter; // plano = power 0 (ปกติ), non_plano = any other power (สายตาสั้น/ยาว)
  unitLabel: string; // "คู่", "ชิ้น", "ขวด" — for display only
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const stockCountGroupSchema = new Schema<IStockCountGroup>(
  {
    name: { type: String, required: true, trim: true },
    sortOrder: { type: Number, default: 0 },
    productIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
    powerFilter: { type: String, enum: POWER_FILTERS, default: 'any' },
    unitLabel: { type: String, default: 'ชิ้น' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const StockCountGroup = model<IStockCountGroup>('StockCountGroup', stockCountGroupSchema);
