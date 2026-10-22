import { Types } from 'mongoose';
import { Sale, ISale } from '../models/Sale';
import { SaleItem } from '../models/SaleItem';
import { Payment } from '../models/Payment';
import { ProductSku } from '../models/ProductSku';
import { Customer } from '../models/Customer';
import { withTransactionRetry } from '../config/db';
import { moveStock } from './inventoryService';
import { evaluateCart, incrementCouponUsage, applyPriceOverrides, CartLineInput } from './promotionService';
import { assertShiftIsOpenForSale } from './shiftService';
import { recordAudit } from './auditService';
import { notify } from './notificationService';
import { ApiError } from '../utils/ApiError';
import { PaymentMethod, SaleChannel } from '../config/constants';

export interface SaleItemInput {
  skuId: string;
  qty: number;
  /** Cashier-entered unit price in satang (0 = giveaway). Requires a reason. */
  unitPriceOverride?: number;
  overrideReason?: string;
  /** Cashier confirmed the item is on hand although the system count is short (stock may go negative). */
  allowOversell?: boolean;
}

export interface SalePaymentInput {
  method: PaymentMethod;
  amount: number;
  referenceNo?: string;
}

export interface CreateSaleInput {
  branchId: string;
  shiftSessionId: string;
  channel?: SaleChannel;
  customerId?: string;
  items: SaleItemInput[];
  payments: SalePaymentInput[];
  promotionIds?: string[]; // promotions the cashier picked; none apply otherwise
  couponCode?: string;
  idempotencyKey: string;
  soldBy: string;
}

/**
 * Creates a completed in-store sale. This is the single most
 * concurrency-sensitive operation in the system (spec B6/B8):
 *   - Idempotency key short-circuits duplicate submits (double-tap, retry).
 *   - Every SKU's stock is decremented with one atomic conditional update
 *     per line, all inside the same DB transaction as the Sale/SaleItem/
 *     Payment writes, so a bill is never half-committed.
 *   - Split payments must sum exactly to the net total before anything is
 *     written.
 *   - Bounded retry only on transient transaction errors; any business
 *     rejection (insufficient stock, payment mismatch) surfaces to the
 *     caller immediately.
 */
export async function createSale(input: CreateSaleInput): Promise<ISale> {
  const existing = await Sale.findOne({ idempotencyKey: input.idempotencyKey });
  if (existing) return existing;

  if (input.items.length === 0) throw ApiError.badRequest('Sale must have at least one item');
  const channel = input.channel ?? 'store';
  for (const item of input.items) {
    if (item.unitPriceOverride !== undefined && !item.overrideReason?.trim()) {
      throw ApiError.badRequest('A reason is required when changing the price by hand');
    }
  }

  const shift = await assertShiftIsOpenForSale(input.shiftSessionId);
  if (shift.branchId.toString() !== input.branchId) {
    throw ApiError.badRequest('Shift session does not belong to the given branch');
  }

  const skuIds = input.items.map((i) => i.skuId);
  const skus = await ProductSku.find({ _id: { $in: skuIds } });
  if (skus.length !== new Set(skuIds).size) throw ApiError.badRequest('One or more SKUs not found');
  const skuMap = new Map(skus.map((s) => [s._id.toString(), s]));
  for (const s of skus) {
    if (!s.active) throw ApiError.badRequest(`SKU ${s.skuCode} is not active`);
  }

  const cartLines: CartLineInput[] = input.items.map((i) => ({ sku: skuMap.get(i.skuId)!, qty: i.qty }));
  const overrides = new Map(input.items.filter((i) => i.unitPriceOverride !== undefined).map((i) => [i.skuId, i.unitPriceOverride!]));
  const overrideReasons = new Map(input.items.filter((i) => i.overrideReason).map((i) => [i.skuId, i.overrideReason!.trim()]));
  const cart = applyPriceOverrides(
    await evaluateCart({
      branchId: input.branchId,
      channel,
      customerId: input.customerId,
      lines: cartLines,
      promotionIds: input.promotionIds,
      couponCode: input.couponCode,
    }),
    overrides,
  );

  // A giveaway-only bill (net 0) has nothing to pay; anything else needs payment lines.
  if (input.payments.length === 0 && cart.netTotal > 0) throw ApiError.badRequest('At least one payment line is required');

  const paymentSum = input.payments.reduce((sum, p) => sum + p.amount, 0);
  if (paymentSum !== cart.netTotal) {
    throw ApiError.badRequest(`Payment total (${paymentSum}) must equal the net total (${cart.netTotal})`, {
      paymentSum,
      netTotal: cart.netTotal,
    });
  }

  try {
    const sale = await withTransactionRetry(async (session) => {
      const oversellSkus = new Set(input.items.filter((i) => i.allowOversell).map((i) => i.skuId));
      const oversold = new Map<string, number>();
      for (const line of cart.lines) {
        const { oversoldQty } = await moveStock({
          branchId: input.branchId,
          skuId: line.skuId,
          type: 'sale_out',
          qty: line.qty,
          refType: 'Sale',
          performedBy: input.soldBy,
          saleChannel: channel === 'store' ? 'store' : 'online',
          allowOversell: oversellSkus.has(line.skuId.toString()),
          session,
        });
        if (oversoldQty > 0) oversold.set(line.skuId.toString(), (oversold.get(line.skuId.toString()) ?? 0) + oversoldQty);
      }

      const [saleDoc] = await Sale.create(
        [
          {
            branchId: input.branchId,
            shiftSessionId: input.shiftSessionId,
            channel,
            customerId: input.customerId,
            subtotal: cart.subtotal,
            discountTotal: cart.discountTotal,
            netTotal: cart.netTotal,
            paymentStatus: 'paid',
            status: 'completed',
            cartPromotionId: cart.cartPromotionId,
            couponId: cart.couponId,
            soldBy: input.soldBy,
            idempotencyKey: input.idempotencyKey,
          },
        ],
        { session },
      );

      await SaleItem.create(
        cart.lines.map((line) => ({
          saleId: saleDoc._id,
          skuId: line.skuId,
          qty: line.qty,
          unitPriceAtSale: line.unitPriceFinal,
          unitCostAtSale: skuMap.get(line.skuId)!.cost,
          promotionId: line.promotionId,
          discountApplied: (line.unitPriceTiered - line.unitPriceFinal) * line.qty,
          priceOverrideReason: overrides.has(line.skuId) ? overrideReasons.get(line.skuId) : undefined,
          lineTotal: line.lineTotal,
          oversoldQty: oversold.get(line.skuId.toString()),
        })),
        { session, ordered: true },
      );

      await Payment.create(
        input.payments.map((p) => ({
          parentType: 'Sale',
          parentId: saleDoc._id,
          method: p.method,
          amount: p.amount,
          referenceNo: p.referenceNo,
          createdBy: input.soldBy,
        })),
        { session, ordered: true },
      );

      if (cart.couponId) await incrementCouponUsage(cart.couponId);

      if (input.customerId) {
        await Customer.findByIdAndUpdate(input.customerId, { $inc: { totalSpend: cart.netTotal } }, { session });
      }

      await recordAudit(
        {
          userId: input.soldBy,
          branchId: input.branchId,
          action: 'sale.create',
          entityType: 'Sale',
          entityId: saleDoc._id.toString(),
          after: {
            netTotal: cart.netTotal,
            itemCount: cart.lines.length,
            channel,
            priceOverrides: Object.fromEntries(overrides),
            ...(oversold.size > 0 && { oversold: Object.fromEntries(oversold) }),
          },
        },
        session,
      );

      return saleDoc;
    });

    await notify({
      type: 'sale_completed',
      branchId: input.branchId,
      payload: { saleId: sale._id.toString(), netTotal: sale.netTotal },
    });

    return sale;
  } catch (err) {
    // Re-check idempotency: a retried request may have raced a prior
    // attempt that actually committed (e.g. client retried after a
    // network blip on the response, not the transaction itself).
    const raced = await Sale.findOne({ idempotencyKey: input.idempotencyKey });
    if (raced) return raced;
    throw err;
  }
}

export async function getSale(saleId: string) {
  const sale = await Sale.findById(saleId).populate('branchId customerId soldBy');
  if (!sale) throw ApiError.notFound('Sale not found');
  const items = await SaleItem.find({ saleId }).populate('skuId');
  const payments = await Payment.find({ parentType: 'Sale', parentId: saleId });
  return { sale, items, payments };
}

export async function listSales(params: { branchId?: string; shiftSessionId?: string; from?: Date; to?: Date }) {
  const filter: Record<string, unknown> = {};
  if (params.branchId) filter.branchId = params.branchId;
  if (params.shiftSessionId) filter.shiftSessionId = params.shiftSessionId;
  if (params.from || params.to) {
    filter.createdAt = {};
    if (params.from) (filter.createdAt as Record<string, Date>).$gte = params.from;
    if (params.to) (filter.createdAt as Record<string, Date>).$lte = params.to;
  }
  return Sale.find(filter).sort({ createdAt: -1 }).limit(500).populate('customerId soldBy');
}
