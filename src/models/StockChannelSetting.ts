import { Schema, model, Types } from 'mongoose';
import { STOCK_CHANNEL_MODES, StockChannelMode } from '../config/constants';

export interface IStockChannelSetting {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  skuId: Types.ObjectId;
  mode: StockChannelMode;
  onlineReservedQty?: number; // used when mode === 'split'
  createdAt: Date;
  updatedAt: Date;
}

const stockChannelSettingSchema = new Schema<IStockChannelSetting>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'ProductSku', required: true },
    mode: { type: String, enum: STOCK_CHANNEL_MODES, required: true },
    onlineReservedQty: { type: Number, default: 0 },
  },
  { timestamps: true },
);

stockChannelSettingSchema.index({ branchId: 1, skuId: 1 }, { unique: true });

export const StockChannelSetting = model<IStockChannelSetting>('StockChannelSetting', stockChannelSettingSchema);
