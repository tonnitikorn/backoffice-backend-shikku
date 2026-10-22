import { Schema, model, Types } from 'mongoose';

export interface IInventory {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  skuId: Types.ObjectId;
  qtyOnHand: number;
  /**
   * Only meaningful when StockChannelSetting.mode === 'split' for this
   * branch+sku: the slice of qtyOnHand ring-fenced for online sales, kept
   * on the same document as qtyOnHand so the store-vs-online guard can be
   * a single atomic conditional update (see inventoryService.moveStock).
   */
  onlineReservedQty: number;
  updatedAt: Date;
  createdAt: Date;
}

/**
 * Stock "in transit" during a branch-to-branch transfer is deliberately NOT
 * a field here — it belongs to neither branch and double-bookkeeping it on
 * both sides risks desync. It is derived on demand from
 * StockTransfer/StockTransferItem docs with status in (sent, in_transit),
 * which is also how the B7 "in-transit" report column is produced.
 */
const inventorySchema = new Schema<IInventory>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'ProductSku', required: true },
    qtyOnHand: { type: Number, required: true, default: 0 },
    onlineReservedQty: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

inventorySchema.index({ branchId: 1, skuId: 1 }, { unique: true });
inventorySchema.index({ skuId: 1 });

export const Inventory = model<IInventory>('Inventory', inventorySchema);
