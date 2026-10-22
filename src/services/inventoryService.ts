import { ClientSession, Types } from 'mongoose';
import { Inventory } from '../models/Inventory';
import { InventoryTransaction } from '../models/InventoryTransaction';
import { StockChannelSetting } from '../models/StockChannelSetting';
import { InventoryTxnType } from '../config/constants';
import { ApiError } from '../utils/ApiError';

export interface StockMoveInput {
  branchId: Types.ObjectId | string;
  skuId: Types.ObjectId | string;
  type: InventoryTxnType;
  qty: number; // always positive; direction is derived from `type`
  refType?: string;
  refId?: Types.ObjectId | string;
  lot?: string;
  expiryDate?: Date;
  reason?: string;
  performedBy: Types.ObjectId | string;
  session: ClientSession;
  /** Only relevant for type 'sale_out' — which side of a channel split is consuming stock (spec B6/B8). */
  saleChannel?: 'store' | 'online';
  /**
   * Only for 'sale_out' at the POS: the cashier confirmed the item is physically
   * there even though the system count is short. The sale goes through, stock may
   * go negative, and the shortfall is returned so it can be flagged for review.
   */
  allowOversell?: boolean;
}

const DECREASE_TYPES: InventoryTxnType[] = [
  'sale_out',
  'transfer_out',
  'damage_out',
  'internal_use_out',
  'adjustment_decrease',
  'write_off',
];

/**
 * The single choke point for every stock mutation in the system. Increases
 * upsert-and-increment; decreases use one atomic conditional update (qty
 * check + decrement in the same operation) so two concurrent sales of the
 * last unit cannot both succeed (spec B6, item 1). Every call must run
 * inside the same DB session/transaction as the sibling writes (Sale,
 * Purchase, Refund, etc.) so stock and ledger never diverge.
 */
export async function moveStock(input: StockMoveInput): Promise<{ balanceAfter: number; oversoldQty: number }> {
  const { branchId, skuId, type, qty, session } = input;
  if (qty <= 0) throw ApiError.badRequest('Stock movement quantity must be positive');

  const isDecrease = DECREASE_TYPES.includes(type);
  const signedQty = isDecrease ? -qty : qty;

  let updated;
  let oversoldQty = 0;
  if (isDecrease) {
    let filter: Record<string, unknown> = { branchId, skuId, qtyOnHand: { $gte: qty } };
    let inc: Record<string, number> = { qtyOnHand: -qty };

    if (type === 'sale_out') {
      const channelSetting = await StockChannelSetting.findOne({ branchId, skuId }).session(session);
      if (channelSetting?.mode === 'split') {
        if (input.saleChannel === 'online') {
          filter = { branchId, skuId, onlineReservedQty: { $gte: qty } };
          inc = { qtyOnHand: -qty, onlineReservedQty: -qty };
        } else {
          // Store sale in split mode must not eat into the online-reserved slice.
          filter = {
            branchId,
            skuId,
            $expr: { $gte: [{ $subtract: ['$qtyOnHand', '$onlineReservedQty'] }, qty] },
          };
          inc = { qtyOnHand: -qty };
        }
      }
    }

    updated = await Inventory.findOneAndUpdate(filter, { $inc: inc }, { session, new: true });
    if (!updated) {
      const current = await Inventory.findOne({ branchId, skuId }).session(session);
      const available = current ? current.qtyOnHand - (input.saleChannel === 'online' ? 0 : current.onlineReservedQty) : 0;
      if (!(type === 'sale_out' && input.allowOversell)) {
        throw ApiError.conflict('Insufficient stock', {
          skuId: skuId.toString(),
          branchId: branchId.toString(),
          available,
          requested: qty,
        });
      }
      oversoldQty = qty - Math.max(available, 0);
      updated = await Inventory.findOneAndUpdate(
        { branchId, skuId },
        { $inc: { qtyOnHand: -qty }, $setOnInsert: { branchId, skuId } },
        { session, new: true, upsert: true },
      );
    }
  } else {
    updated = await Inventory.findOneAndUpdate(
      { branchId, skuId },
      { $inc: { qtyOnHand: qty }, $setOnInsert: { branchId, skuId } },
      { session, new: true, upsert: true },
    );
  }

  await InventoryTransaction.create(
    [
      {
        branchId,
        skuId,
        type,
        qtyChange: signedQty,
        balanceAfter: updated.qtyOnHand,
        refType: input.refType,
        refId: input.refId,
        lot: input.lot,
        expiryDate: input.expiryDate,
        reason: oversoldQty > 0 ? `ขายเกินสต๊อก ${oversoldQty}` : input.reason,
        performedBy: input.performedBy,
      },
    ],
    { session },
  );

  return { balanceAfter: updated.qtyOnHand, oversoldQty };
}

/**
 * Reverses a previous ledger entry by applying the opposite movement and
 * linking back to it (spec B6: corrections are reversals, never edits).
 */
export async function reverseStockMove(
  originalTxnId: Types.ObjectId | string,
  performedBy: Types.ObjectId | string,
  reason: string,
  session: ClientSession,
): Promise<{ balanceAfter: number }> {
  const original = await InventoryTransaction.findById(originalTxnId).session(session);
  if (!original) throw ApiError.notFound('Original inventory transaction not found');

  const reversedIsDecrease = original.qtyChange > 0; // reversing an increase decreases, and vice versa
  const qty = Math.abs(original.qtyChange);
  const signedQty = reversedIsDecrease ? -qty : qty;

  const updated = reversedIsDecrease
    ? await Inventory.findOneAndUpdate(
        { branchId: original.branchId, skuId: original.skuId, qtyOnHand: { $gte: qty } },
        { $inc: { qtyOnHand: -qty } },
        { session, new: true },
      )
    : await Inventory.findOneAndUpdate(
        { branchId: original.branchId, skuId: original.skuId },
        { $inc: { qtyOnHand: qty } },
        { session, new: true, upsert: true },
      );

  if (!updated) {
    throw ApiError.conflict('Cannot reverse: insufficient stock to reverse this increase');
  }

  await InventoryTransaction.create(
    [
      {
        branchId: original.branchId,
        skuId: original.skuId,
        type: 'reversal',
        qtyChange: signedQty,
        balanceAfter: updated.qtyOnHand,
        refType: original.refType,
        refId: original.refId,
        reason,
        performedBy,
        reversalOfId: original._id,
      },
    ],
    { session },
  );

  return { balanceAfter: updated.qtyOnHand };
}

export async function getQtyOnHand(branchId: Types.ObjectId | string, skuId: Types.ObjectId | string): Promise<number> {
  const doc = await Inventory.findOne({ branchId, skuId });
  return doc?.qtyOnHand ?? 0;
}

export async function getQtyOnHandMap(
  branchId: Types.ObjectId | string,
  skuIds: (Types.ObjectId | string)[],
): Promise<Record<string, number>> {
  const docs = await Inventory.find({ branchId, skuId: { $in: skuIds } });
  const map: Record<string, number> = {};
  for (const id of skuIds) map[id.toString()] = 0;
  for (const doc of docs) map[doc.skuId.toString()] = doc.qtyOnHand;
  return map;
}

/**
 * Daily reconciliation: compares each Inventory.qtyOnHand against the sum
 * of its ledger entries and returns any mismatches for the admin alert
 * (spec B6). Intended to be invoked by a scheduled job (see src/jobs).
 */
export async function reconcileInventory(): Promise<
  Array<{ branchId: string; skuId: string; inventoryQty: number; ledgerSum: number }>
> {
  const mismatches: Array<{ branchId: string; skuId: string; inventoryQty: number; ledgerSum: number }> = [];
  const inventories = await Inventory.find();

  for (const inv of inventories) {
    const agg = await InventoryTransaction.aggregate([
      { $match: { branchId: inv.branchId, skuId: inv.skuId } },
      { $group: { _id: null, total: { $sum: '$qtyChange' } } },
    ]);
    const ledgerSum = agg[0]?.total ?? 0;
    if (ledgerSum !== inv.qtyOnHand) {
      mismatches.push({
        branchId: inv.branchId.toString(),
        skuId: inv.skuId.toString(),
        inventoryQty: inv.qtyOnHand,
        ledgerSum,
      });
    }
  }
  return mismatches;
}
