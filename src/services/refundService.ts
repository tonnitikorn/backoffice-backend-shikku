import { Types } from 'mongoose';
import { Refund, IRefund, IRefundChannelLine } from '../models/Refund';
import { RefundItem } from '../models/RefundItem';
import { Sale } from '../models/Sale';
import { SaleItem } from '../models/SaleItem';
import { Order } from '../models/Order';
import { OrderItem } from '../models/OrderItem';
import { Payment } from '../models/Payment';
import { Customer } from '../models/Customer';
import { withTransactionRetry } from '../config/db';
import { moveStock } from './inventoryService';
import { getOpenShiftForBranch } from './shiftService';
import { getSetting } from './settingsService';
import { SETTING_KEYS } from '../models/Setting';
import { recordAudit } from './auditService';
import { notify } from './notificationService';
import { ApiError } from '../utils/ApiError';
import { ItemCondition, StockDestination, RefundType, PaymentMethod } from '../config/constants';

function suggestStockDestination(condition: ItemCondition): StockDestination {
  // spec B10 table: sealed -> back to stock; opened/defective -> written off;
  // wrong_item defaults to sealed handling (shop's own mis-pick) but the
  // approver can override per item when the physical condition differs.
  if (condition === 'sealed' || condition === 'wrong_item') return 'return_stock';
  return 'write_off';
}

export interface RefundItemRequestInput {
  originalItemId: string;
  qty: number;
  condition: ItemCondition;
  stockDestinationOverride?: StockDestination;
}

export interface CreateRefundRequestInput {
  originalType: 'Sale' | 'Order';
  originalId: string;
  type: RefundType;
  items: RefundItemRequestInput[];
  reason: string;
  requestedBy: string;
}

async function loadOriginal(originalType: 'Sale' | 'Order', originalId: string) {
  if (originalType === 'Sale') {
    const sale = await Sale.findById(originalId);
    if (!sale) throw ApiError.notFound('Sale not found');
    const items = await SaleItem.find({ saleId: sale._id });
    return { branchId: sale.branchId, subtotal: sale.subtotal, netTotal: sale.netTotal, items };
  }
  const order = await Order.findById(originalId);
  if (!order) throw ApiError.notFound('Order not found');
  const items = await OrderItem.find({ orderId: order._id });
  return { branchId: order.branchId, subtotal: order.subtotal, netTotal: order.netTotal, items };
}

/**
 * Staff/manager/admin create a refund/exchange REQUEST (spec B10): nothing
 * moves yet — no stock, no money — until Branch Manager/Admin approves it.
 * Store-channel refunds are pinned to the branch's currently open shift
 * (variance shows up there); online-order refunds have no shift and are
 * cash-only never (spec: "คืนเงินเป็นการโอนเท่านั้น").
 */
export async function createRefundRequest(input: CreateRefundRequestInput): Promise<IRefund> {
  const original = await loadOriginal(input.originalType, input.originalId);

  let shiftSessionId: Types.ObjectId | undefined;
  if (input.originalType === 'Sale') {
    const openShift = await getOpenShiftForBranch(original.branchId.toString());
    if (!openShift) throw ApiError.conflict('No open shift on this branch — open a shift before recording a store refund');
    shiftSessionId = openShift._id;
  }

  const refund = await Refund.create({
    branchId: original.branchId,
    shiftSessionId,
    originalType: input.originalType,
    originalId: input.originalId,
    type: input.type,
    reason: input.reason,
    status: 'pending',
    refundChannelLines: [],
    totalRefundAmount: 0,
    requestedBy: input.requestedBy,
  });

  let totalRefundAmount = 0;
  const refundItems = [];
  for (const reqItem of input.items) {
    const originalItem = original.items.find((i) => i._id.toString() === reqItem.originalItemId);
    if (!originalItem) throw ApiError.badRequest(`Original item not found: ${reqItem.originalItemId}`);
    const remaining = originalItem.qty - originalItem.refundedQty;
    if (reqItem.qty > remaining) {
      throw ApiError.badRequest(`Cannot refund ${reqItem.qty} — only ${remaining} remain un-refunded for this line`);
    }

    const unitRefundAmount = Math.round(originalItem.unitPriceAtSale); // already net of line-level discount
    totalRefundAmount += unitRefundAmount * reqItem.qty;

    refundItems.push({
      refundId: refund._id,
      originalItemId: originalItem._id,
      skuId: originalItem.skuId,
      qty: reqItem.qty,
      unitRefundAmount,
      condition: reqItem.condition,
      stockDestination: reqItem.stockDestinationOverride ?? suggestStockDestination(reqItem.condition),
    });
  }

  await RefundItem.insertMany(refundItems);
  refund.totalRefundAmount = totalRefundAmount;
  await refund.save();

  await recordAudit({
    userId: input.requestedBy,
    branchId: original.branchId,
    action: 'refund.request',
    entityType: 'Refund',
    entityId: refund._id.toString(),
    after: { totalRefundAmount, itemCount: refundItems.length },
  });

  await notify({ type: 'refund_requested', branchId: original.branchId.toString(), role: 'branch_manager', payload: { refundId: refund._id.toString() } });

  return refund;
}

export async function approveRefund(
  refundId: string,
  approvedBy: string,
  refundChannelLines: IRefundChannelLine[],
): Promise<IRefund> {
  const refund = await Refund.findById(refundId);
  if (!refund) throw ApiError.notFound('Refund not found');
  if (refund.status !== 'pending') throw ApiError.conflict('Refund is not pending');

  const channelSum = refundChannelLines.reduce((sum, l) => sum + l.amount, 0);
  if (channelSum !== refund.totalRefundAmount) {
    throw ApiError.badRequest(`Refund channel lines (${channelSum}) must sum to the refund total (${refund.totalRefundAmount})`);
  }

  if (refund.originalType === 'Order' && refundChannelLines.some((l) => l.method === 'cash')) {
    throw ApiError.badRequest('Online order refunds must be paid back via transfer, never cash');
  }

  // Split-bill cap: each channel line cannot exceed what was originally paid via that method.
  const originalPayments = await Payment.find({
    parentType: refund.originalType,
    parentId: refund.originalId,
  });
  const paidByMethod = new Map<PaymentMethod, number>();
  for (const p of originalPayments) paidByMethod.set(p.method, (paidByMethod.get(p.method) ?? 0) + p.amount);
  const alreadyRefundedByMethod = await getAlreadyRefundedByMethod(refund.originalType, refund.originalId);
  for (const line of refundChannelLines) {
    const cap = (paidByMethod.get(line.method) ?? 0) - (alreadyRefundedByMethod.get(line.method) ?? 0);
    if (line.amount > cap) {
      throw ApiError.badRequest(`Refund via ${line.method} (${line.amount}) exceeds the remaining amount paid by that method (${cap})`);
    }
  }

  const items = await RefundItem.find({ refundId: refund._id });

  await withTransactionRetry(async (session) => {
    for (const item of items) {
      if (item.stockDestination === 'return_stock') {
        await moveStock({
          branchId: refund.branchId,
          skuId: item.skuId,
          type: 'return_in',
          qty: item.qty,
          lot: item.lot,
          expiryDate: item.expiryDate,
          refType: 'Refund',
          refId: refund._id,
          reason: 'Customer return — sealed/acceptable condition',
          performedBy: approvedBy,
          session,
        });
      }

      if (refund.originalType === 'Sale') {
        await SaleItem.findByIdAndUpdate(item.originalItemId, { $inc: { refundedQty: item.qty } }, { session });
      } else {
        await OrderItem.findByIdAndUpdate(item.originalItemId, { $inc: { refundedQty: item.qty } }, { session });
      }
    }

    refund.status = 'approved';
    refund.approvedBy = new Types.ObjectId(approvedBy);
    refund.approvedAt = new Date();
    refund.refundChannelLines = refundChannelLines;
    await refund.save({ session });

    await Payment.create(
      refundChannelLines.map((l) => ({
        parentType: refund.originalType,
        parentId: refund.originalId,
        method: l.method,
        amount: -l.amount,
        createdBy: approvedBy,
      })),
      { session, ordered: true },
    );

    await recordAudit(
      {
        userId: approvedBy,
        branchId: refund.branchId,
        action: 'refund.approve',
        entityType: 'Refund',
        entityId: refund._id.toString(),
        after: { totalRefundAmount: refund.totalRefundAmount },
      },
      session,
    );
  });

  // Point clawback is proportional to the refunded share of the bill (Open
  // Question per spec Part C — points earn/redeem rules are unconfirmed);
  // we still reverse the totalSpend contribution so member-level thresholds
  // stay accurate.
  const parent = refund.originalType === 'Sale' ? await Sale.findById(refund.originalId) : await Order.findById(refund.originalId);
  const customerId = (parent as { customerId?: Types.ObjectId } | null)?.customerId;
  if (customerId) {
    await Customer.findByIdAndUpdate(customerId, { $inc: { totalSpend: -refund.totalRefundAmount } });
  }

  await notify({ type: 'refund_decided', branchId: refund.branchId.toString(), payload: { refundId: refund._id.toString(), status: 'approved' } });

  return refund;
}

async function getAlreadyRefundedByMethod(originalType: 'Sale' | 'Order', originalId: Types.ObjectId) {
  const refundPayments = await Payment.find({ parentType: originalType, parentId: originalId, amount: { $lt: 0 } });
  const map = new Map<PaymentMethod, number>();
  for (const p of refundPayments) map.set(p.method, (map.get(p.method) ?? 0) + Math.abs(p.amount));
  return map;
}

export async function rejectRefund(refundId: string, rejectedBy: string, reason: string): Promise<IRefund> {
  const refund = await Refund.findById(refundId);
  if (!refund) throw ApiError.notFound('Refund not found');
  if (refund.status !== 'pending') throw ApiError.conflict('Refund is not pending');

  refund.status = 'rejected';
  refund.approvedBy = new Types.ObjectId(rejectedBy);
  refund.approvedAt = new Date();
  refund.reason = `${refund.reason} | Rejected: ${reason}`;
  await refund.save();

  await recordAudit({ userId: rejectedBy, branchId: refund.branchId, action: 'refund.reject', entityType: 'Refund', entityId: refund._id.toString(), after: { reason } });
  await notify({ type: 'refund_decided', branchId: refund.branchId.toString(), payload: { refundId: refund._id.toString(), status: 'rejected' } });

  return refund;
}

export async function getRefund(refundId: string) {
  const refund = await Refund.findById(refundId).populate('branchId requestedBy approvedBy');
  if (!refund) throw ApiError.notFound('Refund not found');
  const items = await RefundItem.find({ refundId: refund._id }).populate('skuId');
  return { refund, items };
}

export async function listRefunds(params: { branchId?: string; status?: string }) {
  const filter: Record<string, unknown> = {};
  if (params.branchId) filter.branchId = params.branchId;
  if (params.status) filter.status = params.status;
  return Refund.find(filter).sort({ createdAt: -1 }).limit(300).populate('requestedBy approvedBy');
}

export async function getReturnWindowDays(): Promise<number> {
  const policy = await getSetting<{ returnWindowDays: number }>(SETTING_KEYS.refundPolicy);
  return policy.returnWindowDays;
}
