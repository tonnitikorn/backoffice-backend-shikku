import { Schema, model, Types } from 'mongoose';
import { PROMOTION_TYPES, PromotionType, SALE_CHANNELS, SaleChannel } from '../config/constants';

export interface IPromotion {
  _id: Types.ObjectId;
  name: string;
  type: PromotionType;
  scopeBranchIds: Types.ObjectId[]; // empty = all branches
  scopeChannels: SaleChannel[]; // empty = all channels
  scopeSkuIds: Types.ObjectId[]; // empty = all SKUs
  scopeMemberLevelIds: Types.ObjectId[]; // empty = all members
  startAt: Date;
  endAt: Date;
  stackable: boolean;
  config: {
    percentOff?: number;
    amountOff?: number; // satang
    buyQty?: number;
    getQty?: number;
    spendThreshold?: number; // satang
    spendDiscountAmount?: number; // satang
  };
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const promotionSchema = new Schema<IPromotion>(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: PROMOTION_TYPES, required: true },
    scopeBranchIds: [{ type: Schema.Types.ObjectId, ref: 'Branch' }],
    scopeChannels: [{ type: String, enum: SALE_CHANNELS }],
    scopeSkuIds: [{ type: Schema.Types.ObjectId, ref: 'ProductSku' }],
    scopeMemberLevelIds: [{ type: Schema.Types.ObjectId, ref: 'MemberLevel' }],
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    stackable: { type: Boolean, default: false },
    config: {
      percentOff: Number,
      amountOff: Number,
      buyQty: Number,
      getQty: Number,
      spendThreshold: Number,
      spendDiscountAmount: Number,
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

promotionSchema.index({ active: 1, startAt: 1, endAt: 1 });

export const Promotion = model<IPromotion>('Promotion', promotionSchema);
