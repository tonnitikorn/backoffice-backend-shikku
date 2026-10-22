import { Schema, model, Types } from 'mongoose';
import { TRANSFER_STATUSES, TransferStatus } from '../config/constants';

export interface IStockTransfer {
  _id: Types.ObjectId;
  fromBranchId: Types.ObjectId;
  toBranchId: Types.ObjectId;
  status: TransferStatus;
  sentBy: Types.ObjectId;
  sentAt: Date;
  carrierInfo?: string;
  markedInTransitAt?: Date;
  receivedBy?: Types.ObjectId;
  receivedAt?: Date;
  discrepancyNotes?: string;
  cancelledBy?: Types.ObjectId;
  cancelledAt?: Date;
  cancelReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const stockTransferSchema = new Schema<IStockTransfer>(
  {
    fromBranchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    toBranchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    status: { type: String, enum: TRANSFER_STATUSES, default: 'sent' },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sentAt: { type: Date, required: true },
    carrierInfo: { type: String },
    markedInTransitAt: { type: Date },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    receivedAt: { type: Date },
    discrepancyNotes: { type: String },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    cancelledAt: { type: Date },
    cancelReason: { type: String },
  },
  { timestamps: true },
);

stockTransferSchema.index({ status: 1 });
stockTransferSchema.index({ fromBranchId: 1, toBranchId: 1 });

export const StockTransfer = model<IStockTransfer>('StockTransfer', stockTransferSchema);
