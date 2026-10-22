import { Schema, model, Types } from 'mongoose';
import { INVENTORY_TXN_TYPES, InventoryTxnType } from '../config/constants';

/**
 * Append-only stock ledger (spec B6). Every write must happen in the same
 * DB transaction as the corresponding Inventory.qtyOnHand update — see
 * inventoryService.applyLedgerEntry(). Corrections are reversal entries,
 * never edits to an existing row.
 */
export interface IInventoryTransaction {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  skuId: Types.ObjectId;
  type: InventoryTxnType;
  qtyChange: number; // positive or negative
  balanceAfter: number;
  lot?: string;
  expiryDate?: Date;
  refType?: string; // 'Purchase' | 'Sale' | 'Order' | 'StockTransfer' | 'Refund' | 'Adjustment'
  refId?: Types.ObjectId;
  reason?: string;
  performedBy: Types.ObjectId;
  reversalOfId?: Types.ObjectId;
  createdAt: Date;
}

const inventoryTransactionSchema = new Schema<IInventoryTransaction>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    skuId: { type: Schema.Types.ObjectId, ref: 'ProductSku', required: true },
    type: { type: String, enum: INVENTORY_TXN_TYPES, required: true },
    qtyChange: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    lot: { type: String },
    expiryDate: { type: Date },
    refType: { type: String },
    refId: { type: Schema.Types.ObjectId },
    reason: { type: String },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reversalOfId: { type: Schema.Types.ObjectId, ref: 'InventoryTransaction' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

inventoryTransactionSchema.index({ branchId: 1, skuId: 1, createdAt: -1 });
inventoryTransactionSchema.index({ refType: 1, refId: 1 });
inventoryTransactionSchema.index({ expiryDate: 1 });

inventoryTransactionSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function (next) {
  next(new Error('inventory_transactions is append-only'));
});
inventoryTransactionSchema.pre(['deleteOne', 'findOneAndDelete', 'deleteMany'], function (next) {
  next(new Error('inventory_transactions is append-only'));
});

export const InventoryTransaction = model<IInventoryTransaction>('InventoryTransaction', inventoryTransactionSchema);
