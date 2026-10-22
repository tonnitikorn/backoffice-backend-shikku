import { Types } from 'mongoose';
import { StockTransfer, IStockTransfer } from '../models/StockTransfer';
import { StockTransferItem } from '../models/StockTransferItem';
import { ProductSku } from '../models/ProductSku';
import { withTransactionRetry } from '../config/db';
import { moveStock, reverseStockMove } from './inventoryService';
import { InventoryTransaction } from '../models/InventoryTransaction';
import { recordAudit } from './auditService';
import { notify } from './notificationService';
import { getSetting } from './settingsService';
import { SETTING_KEYS } from '../models/Setting';
import { ApiError } from '../utils/ApiError';

export interface TransferItemInput {
  skuId: string;
  qty: number;
  lot?: string;
  expiryDate?: string;
}

/**
 * Ships stock from one branch to another (spec B7). Never edits either
 * branch's stock directly — origin stock is cut immediately via a normal
 * transfer_out ledger entry; destination only gains stock once explicitly
 * received. Cost travels with the goods (costAtTransfer snapshot) so no
 * profit/loss is created by the move itself.
 */
export async function createTransfer(input: {
  fromBranchId: string;
  toBranchId: string;
  items: TransferItemInput[];
  sentBy: string;
}): Promise<IStockTransfer> {
  if (input.fromBranchId === input.toBranchId) throw ApiError.badRequest('Source and destination branch must differ');
  if (input.items.length === 0) throw ApiError.badRequest('Transfer must have at least one item');

  const skus = await ProductSku.find({ _id: { $in: input.items.map((i) => i.skuId) } });
  const skuMap = new Map(skus.map((s) => [s._id.toString(), s]));

  return withTransactionRetry(async (session) => {
    const transferId = new Types.ObjectId();

    for (const item of input.items) {
      await moveStock({
        branchId: input.fromBranchId,
        skuId: item.skuId,
        type: 'transfer_out',
        qty: item.qty,
        lot: item.lot,
        expiryDate: item.expiryDate ? new Date(item.expiryDate) : undefined,
        refType: 'StockTransfer',
        refId: transferId,
        performedBy: input.sentBy,
        session,
      });
    }

    await StockTransfer.create(
      [
        {
          _id: transferId,
          fromBranchId: input.fromBranchId,
          toBranchId: input.toBranchId,
          status: 'sent',
          sentBy: input.sentBy,
          sentAt: new Date(),
        },
      ],
      { session },
    );

    await StockTransferItem.create(
      input.items.map((item) => ({
        transferId,
        skuId: item.skuId,
        qtySent: item.qty,
        lot: item.lot,
        expiryDate: item.expiryDate ? new Date(item.expiryDate) : undefined,
        costAtTransfer: skuMap.get(item.skuId)?.cost ?? 0,
      })),
      { session, ordered: true },
    );

    await recordAudit(
      {
        userId: input.sentBy,
        branchId: input.fromBranchId,
        action: 'stock_transfer.send',
        entityType: 'StockTransfer',
        entityId: transferId.toString(),
        after: { toBranchId: input.toBranchId, itemCount: input.items.length },
      },
      session,
    );

    await notify({ type: 'transfer_incoming', branchId: input.toBranchId, payload: { transferId: transferId.toString() } });

    const created = await StockTransfer.findById(transferId).session(session);
    return created!;
  });
}

export async function markInTransit(transferId: string, carrierInfo: string | undefined, userId: string) {
  const transfer = await StockTransfer.findById(transferId);
  if (!transfer) throw ApiError.notFound('Transfer not found');
  if (transfer.status !== 'sent') throw ApiError.conflict('Only a sent transfer can be marked in transit');

  transfer.status = 'in_transit';
  transfer.carrierInfo = carrierInfo;
  transfer.markedInTransitAt = new Date();
  await transfer.save();

  await recordAudit({ userId, branchId: transfer.fromBranchId, action: 'stock_transfer.in_transit', entityType: 'StockTransfer', entityId: transfer._id.toString() });
  return transfer;
}

export interface ReceiveItemInput {
  itemId: string;
  qtyReceived: number;
  discrepancyReason?: string;
}

export async function receiveTransfer(transferId: string, input: { items: ReceiveItemInput[]; userId: string }) {
  const transfer = await StockTransfer.findById(transferId);
  if (!transfer) throw ApiError.notFound('Transfer not found');
  if (!['sent', 'in_transit'].includes(transfer.status)) throw ApiError.conflict('Transfer cannot be received in its current status');

  const items = await StockTransferItem.find({ transferId: transfer._id });
  const itemMap = new Map(items.map((i) => [i._id.toString(), i]));

  return withTransactionRetry(async (session) => {
    for (const receipt of input.items) {
      const item = itemMap.get(receipt.itemId);
      if (!item) throw ApiError.badRequest(`Transfer item not found: ${receipt.itemId}`);
      if (receipt.qtyReceived > item.qtySent) throw ApiError.badRequest('Cannot receive more than was sent');
      if (receipt.qtyReceived < item.qtySent && !receipt.discrepancyReason) {
        throw ApiError.badRequest(`A reason is required for the shortfall on SKU ${item.skuId}`);
      }

      if (receipt.qtyReceived > 0) {
        await moveStock({
          branchId: transfer.toBranchId,
          skuId: item.skuId,
          type: 'transfer_in',
          qty: receipt.qtyReceived,
          lot: item.lot,
          expiryDate: item.expiryDate,
          refType: 'StockTransfer',
          refId: transfer._id,
          performedBy: input.userId,
          session,
        });
      }

      item.qtyReceived = receipt.qtyReceived;
      item.discrepancyQty = item.qtySent - receipt.qtyReceived;
      item.discrepancyReason = receipt.discrepancyReason;
      item.discrepancyResolution = item.discrepancyQty > 0 ? 'pending' : undefined;
      await item.save({ session });
    }

    transfer.status = 'received';
    transfer.receivedBy = new Types.ObjectId(input.userId);
    transfer.receivedAt = new Date();
    await transfer.save({ session });

    await recordAudit(
      {
        userId: input.userId,
        branchId: transfer.toBranchId,
        action: 'stock_transfer.receive',
        entityType: 'StockTransfer',
        entityId: transfer._id.toString(),
      },
      session,
    );

    return transfer;
  });
}

export async function resolveDiscrepancy(itemId: string, resolution: 'damaged' | 'lost' | 'admin_confirmed', userId: string) {
  const item = await StockTransferItem.findById(itemId);
  if (!item) throw ApiError.notFound('Transfer item not found');
  item.discrepancyResolution = resolution;
  await item.save();
  await recordAudit({ userId, action: 'stock_transfer.discrepancy_resolve', entityType: 'StockTransferItem', entityId: item._id.toString(), after: { resolution } });
  return item;
}

export async function cancelTransfer(transferId: string, userId: string, reason: string) {
  const transfer = await StockTransfer.findById(transferId);
  if (!transfer) throw ApiError.notFound('Transfer not found');
  if (!['sent', 'in_transit'].includes(transfer.status)) {
    throw ApiError.conflict('Only a sent or in-transit transfer can be cancelled');
  }

  return withTransactionRetry(async (session) => {
    const movements = await InventoryTransaction.find({ refType: 'StockTransfer', refId: transfer._id, type: 'transfer_out' }).session(session);
    for (const m of movements) {
      await reverseStockMove(m._id, userId, `Transfer cancelled: ${reason}`, session);
    }

    transfer.status = 'cancelled';
    transfer.cancelledBy = new Types.ObjectId(userId);
    transfer.cancelledAt = new Date();
    transfer.cancelReason = reason;
    await transfer.save({ session });

    await recordAudit(
      { userId, branchId: transfer.fromBranchId, action: 'stock_transfer.cancel', entityType: 'StockTransfer', entityId: transfer._id.toString(), after: { reason } },
      session,
    );

    return transfer;
  });
}

/** Stock "in transit" per SKU (and per branch pair), for the stock screen + reports (spec B7). */
export async function getInTransitSummary(branchId?: string) {
  const match: Record<string, unknown> = {};
  if (branchId) match.$or = [{ fromBranchId: new Types.ObjectId(branchId) }, { toBranchId: new Types.ObjectId(branchId) }];

  const transfers = await StockTransfer.find({ ...match, status: { $in: ['sent', 'in_transit'] } });
  const transferIds = transfers.map((t) => t._id);
  const items = await StockTransferItem.find({ transferId: { $in: transferIds } }).populate('skuId');

  return items.map((item) => {
    const transfer = transfers.find((t) => t._id.equals(item.transferId))!;
    return {
      transferId: transfer._id,
      fromBranchId: transfer.fromBranchId,
      toBranchId: transfer.toBranchId,
      status: transfer.status,
      sku: item.skuId,
      qty: item.qtySent,
      sentAt: transfer.sentAt,
    };
  });
}

export async function findOverdueTransfers() {
  const overdueDays = await getSetting<number>(SETTING_KEYS.transferOverdueDays);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - overdueDays);
  return StockTransfer.find({ status: { $in: ['sent', 'in_transit'] }, sentAt: { $lte: cutoff } });
}

export async function notifyOverdueTransfers() {
  const overdue = await findOverdueTransfers();
  for (const t of overdue) {
    await notify({ type: 'transfer_overdue', branchId: t.toBranchId.toString(), role: 'admin', payload: { transferId: t._id.toString(), sentAt: t.sentAt } });
  }
  return overdue.length;
}
