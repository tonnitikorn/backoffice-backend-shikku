import { Types } from 'mongoose';
import { Order, IOrder } from '../models/Order';
import { OrderItem } from '../models/OrderItem';
import { Payment } from '../models/Payment';
import { ProductSku } from '../models/ProductSku';
import { Customer } from '../models/Customer';
import { ShiftSession } from '../models/ShiftSession';
import { InventoryTransaction } from '../models/InventoryTransaction';
import { withTransactionRetry } from '../config/db';
import { moveStock, reverseStockMove } from './inventoryService';
import { evaluateCart, incrementCouponUsage, CartLineInput } from './promotionService';
import { recordAudit } from './auditService';
import { notify } from './notificationService';
import { ApiError } from '../utils/ApiError';
import { OrderStatus, PaymentMethod, SaleChannel } from '../config/constants';

export interface CreateOrderInput {
  branchId: string;
  customerId?: string;
  channel: Exclude<SaleChannel, 'store'>;
  items: { skuId: string; qty: number }[];
  shippingMethod?: string;
  shippingAddress?: string;
  couponCode?: string;
  promotionIds?: string[]; // promotions picked when logging the order; none apply otherwise
  idempotencyKey: string;
  createdBy: string;
  payments?: { method: PaymentMethod; amount: number; referenceNo?: string }[];
}

/**
 * Creates an online order (spec item 7 / flow item 24): the shop owner logs
 * a chat sale, stock is cut immediately from the chosen source branch using
 * the same atomic guard as in-store sales (channel='online' for the split
 * stock-mode check). It does not need a shift, but if the branch has one
 * open the order is linked to it so it appears in that shift's summary
 * (as "online", apart from walk-in and Grab money).
 */
export async function createOrder(input: CreateOrderInput): Promise<IOrder> {
  const existing = await Order.findOne({ idempotencyKey: input.idempotencyKey });
  if (existing) return existing;

  if (input.items.length === 0) throw ApiError.badRequest('Order must have at least one item');

  const skuIds = input.items.map((i) => i.skuId);
  const skus = await ProductSku.find({ _id: { $in: skuIds } });
  if (skus.length !== new Set(skuIds).size) throw ApiError.badRequest('One or more SKUs not found');
  const skuMap = new Map(skus.map((s) => [s._id.toString(), s]));

  const cartLines: CartLineInput[] = input.items.map((i) => ({ sku: skuMap.get(i.skuId)!, qty: i.qty }));
  const cart = await evaluateCart({
    branchId: input.branchId,
    channel: input.channel,
    customerId: input.customerId,
    lines: cartLines,
    promotionIds: input.promotionIds,
    couponCode: input.couponCode,
  });

  const paymentSum = (input.payments ?? []).reduce((sum, p) => sum + p.amount, 0);
  const openShift = await ShiftSession.findOne({ branchId: input.branchId, status: 'open' }, { _id: 1 });

  try {
    const order = await withTransactionRetry(async (session) => {
      const orderId = new Types.ObjectId();

      for (const line of cart.lines) {
        await moveStock({
          branchId: input.branchId,
          skuId: line.skuId,
          type: 'sale_out',
          qty: line.qty,
          refType: 'Order',
          refId: orderId,
          performedBy: input.createdBy,
          saleChannel: 'online',
          session,
        });
      }

      const [orderDoc] = await Order.create(
        [
          {
            _id: orderId,
            branchId: input.branchId,
            shiftSessionId: openShift?._id,
            customerId: input.customerId,
            channel: input.channel,
            subtotal: cart.subtotal,
            discountTotal: cart.discountTotal,
            netTotal: cart.netTotal,
            shippingMethod: input.shippingMethod,
            shippingAddress: input.shippingAddress,
            paymentStatus: paymentSum >= cart.netTotal ? 'paid' : paymentSum > 0 ? 'partial' : 'unpaid',
            orderStatus: 'confirmed',
            statusHistory: [{ status: 'confirmed', at: new Date(), by: input.createdBy }],
            cartPromotionId: cart.cartPromotionId,
            couponId: cart.couponId,
            createdBy: input.createdBy,
            idempotencyKey: input.idempotencyKey,
          },
        ],
        { session },
      );

      await OrderItem.create(
        cart.lines.map((line) => ({
          orderId: orderDoc._id,
          skuId: line.skuId,
          qty: line.qty,
          unitPriceAtSale: line.unitPriceFinal,
          unitCostAtSale: skuMap.get(line.skuId)!.cost,
          promotionId: line.promotionId,
          discountApplied: (line.unitPriceTiered - line.unitPriceFinal) * line.qty,
          lineTotal: line.lineTotal,
        })),
        { session, ordered: true },
      );

      if (input.payments && input.payments.length > 0) {
        await Payment.create(
          input.payments.map((p) => ({
            parentType: 'Order',
            parentId: orderDoc._id,
            method: p.method,
            amount: p.amount,
            referenceNo: p.referenceNo,
            createdBy: input.createdBy,
          })),
          { session, ordered: true },
        );
      }

      if (cart.couponId) await incrementCouponUsage(cart.couponId);
      if (input.customerId) {
        await Customer.findByIdAndUpdate(input.customerId, { $inc: { totalSpend: cart.netTotal } }, { session });
      }

      await recordAudit(
        {
          userId: input.createdBy,
          branchId: input.branchId,
          action: 'order.create',
          entityType: 'Order',
          entityId: orderDoc._id.toString(),
          after: { netTotal: cart.netTotal, channel: input.channel },
        },
        session,
      );

      return orderDoc;
    });

    return order;
  } catch (err) {
    const raced = await Order.findOne({ idempotencyKey: input.idempotencyKey });
    if (raced) return raced;
    throw err;
  }
}

const TERMINAL_STATUSES: OrderStatus[] = ['delivered', 'cancelled', 'refunded'];

export async function updateOrderStatus(orderId: string, newStatus: OrderStatus, userId: string, note?: string) {
  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound('Order not found');
  if (TERMINAL_STATUSES.includes(order.orderStatus)) {
    throw ApiError.conflict(`Order is already ${order.orderStatus} and cannot change status`);
  }

  if (newStatus === 'cancelled') {
    await withTransactionRetry(async (session) => {
      const movements = await InventoryTransaction.find({ refType: 'Order', refId: order._id, type: 'sale_out' }).session(session);
      for (const m of movements) {
        await reverseStockMove(m._id, userId, 'Order cancelled', session);
      }
      order.orderStatus = 'cancelled';
      order.statusHistory.push({ status: 'cancelled', at: new Date(), by: new Types.ObjectId(userId), note });
      await order.save({ session });
    });
  } else {
    order.orderStatus = newStatus;
    order.statusHistory.push({ status: newStatus, at: new Date(), by: new Types.ObjectId(userId), note });
    await order.save();
  }

  await recordAudit({
    userId,
    branchId: order.branchId,
    action: 'order.status_change',
    entityType: 'Order',
    entityId: order._id.toString(),
    after: { status: newStatus },
  });

  await notify({ type: 'sale_completed', branchId: order.branchId.toString(), payload: { orderId: order._id.toString(), status: newStatus } });

  return order;
}

export async function getOrder(orderId: string) {
  const order = await Order.findById(orderId).populate('branchId customerId createdBy');
  if (!order) throw ApiError.notFound('Order not found');
  const items = await OrderItem.find({ orderId }).populate('skuId');
  const payments = await Payment.find({ parentType: 'Order', parentId: orderId });
  return { order, items, payments };
}

export async function listOrders(params: { branchId?: string; orderStatus?: string; channel?: string }) {
  const filter: Record<string, unknown> = {};
  if (params.branchId) filter.branchId = params.branchId;
  if (params.orderStatus) filter.orderStatus = params.orderStatus;
  if (params.channel) filter.channel = params.channel;
  return Order.find(filter).sort({ createdAt: -1 }).limit(500).populate('customerId createdBy');
}
