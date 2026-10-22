import { Types, ClientSession } from 'mongoose';
import { ShiftSession, IShiftSession } from '../models/ShiftSession';
import { ShiftStockCount } from '../models/ShiftStockCount';
import { StockCountGroup } from '../models/StockCountGroup';
import { ShiftSchedule } from '../models/ShiftSchedule';
import { Sale } from '../models/Sale';
import { SaleItem } from '../models/SaleItem';
import { Order } from '../models/Order';
import { OrderItem } from '../models/OrderItem';
import { ProductSku } from '../models/ProductSku';
import { ProductVariant } from '../models/ProductVariant';
import { Payment } from '../models/Payment';
import { Refund } from '../models/Refund';
import { CashMovement } from '../models/CashMovement';
import { SETTING_KEYS } from '../models/Setting';
import { getSetting } from './settingsService';
import { recordAudit } from './auditService';
import { ApiError } from '../utils/ApiError';
import { salesBucket, SalesBucket } from '../config/constants';
import { notify } from './notificationService';

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export async function getOpenShiftForBranch(branchId: string): Promise<IShiftSession | null> {
  return ShiftSession.findOne({ branchId, status: 'open' });
}

/**
 * Verifies a shift session is open and safe to sell against. Deliberately
 * does NOT require the caller to be the shift's opener: spec B9 allows
 * several staff to share one branch's drawer during a shift ("หลายคนในกะ
 * เดียวกันใช้ลิ้นชักร่วมกัน") — only the opener/closer is accountable for
 * the eventual cash variance, not every seller during the shift. Branch
 * membership for the caller is enforced separately by the route's
 * requireBranchScope middleware.
 */
export async function assertShiftIsOpenForSale(shiftSessionId: string): Promise<IShiftSession> {
  const shift = await ShiftSession.findById(shiftSessionId);
  if (!shift) throw ApiError.notFound('Shift session not found');
  if (shift.status !== 'open') throw ApiError.conflict('Shift is not open for sales');
  return shift;
}

/**
 * Opens a shift/drawer for a branch (spec B9). Requires the counted
 * opening float before any sale can happen. If the opener has no matching
 * published schedule entry for today, a Branch Manager/Admin approver id
 * must be supplied.
 */
export async function openShift(input: {
  branchId: string;
  userId: string;
  openingFloat: number;
  openingFloatVarianceReason?: string;
  approverId?: string;
}) {
  const existing = await getOpenShiftForBranch(input.branchId);
  if (existing) throw ApiError.conflict('A shift is already open for this branch');

  const today = new Date();
  const schedule = await ShiftSchedule.findOne({
    branchId: input.branchId,
    userId: input.userId,
    status: 'published',
    date: { $gte: startOfDay(today), $lte: endOfDay(today) },
  });

  let openedOutsideSchedule = false;
  let openApprovedBy: string | undefined;
  if (!schedule) {
    openedOutsideSchedule = true;
    if (!input.approverId) {
      throw ApiError.forbidden('No published schedule found for today — a Branch Manager/Admin must approve opening this shift');
    }
    openApprovedBy = input.approverId;
  }

  const lastClosed = await ShiftSession.findOne({ branchId: input.branchId, status: 'approved' }).sort({ closedAt: -1 });
  const standardFloats = await getSetting<Record<string, number>>(SETTING_KEYS.openingFloatStandardByBranch);
  const openingFloatExpected = lastClosed?.carryForwardFloat ?? standardFloats[input.branchId] ?? 0;

  if (input.openingFloat !== openingFloatExpected && !input.openingFloatVarianceReason) {
    throw ApiError.badRequest('Opening float differs from the expected amount — a reason is required');
  }

  const session = await ShiftSession.create({
    branchId: input.branchId,
    userId: input.userId,
    scheduleId: schedule?._id,
    shiftDefinitionId: schedule?.shiftDefinitionId,
    openedAt: new Date(),
    openingFloat: input.openingFloat,
    openingFloatExpected,
    openingFloatVarianceReason: input.openingFloatVarianceReason,
    openedOutsideSchedule,
    openApprovedBy,
    status: 'open',
  });

  await recordAudit({
    userId: input.userId,
    branchId: input.branchId,
    action: 'shift.open',
    entityType: 'ShiftSession',
    entityId: session._id.toString(),
    after: session.toObject(),
  });

  return session;
}

async function sumPaymentsForShift(shiftSessionId: Types.ObjectId, method: 'cash' | 'transfer' | 'qr') {
  const saleIds = await Sale.find({ shiftSessionId, status: 'completed' }).distinct('_id');
  if (saleIds.length === 0) return 0;
  const agg = await Payment.aggregate([
    { $match: { parentType: 'Sale', parentId: { $in: saleIds }, method } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return agg[0]?.total ?? 0;
}

async function sumRefundsForShift(shiftSessionId: Types.ObjectId, method: 'cash' | 'transfer' | 'qr') {
  const refunds = await Refund.find({ shiftSessionId, status: 'approved' });
  return refunds.reduce((sum, r) => sum + r.refundChannelLines.filter((l) => l.method === method).reduce((s, l) => s + l.amount, 0), 0);
}

async function sumCashMovements(shiftSessionId: Types.ObjectId) {
  const movements = await CashMovement.find({ shiftSessionId });
  const cashIn = movements.filter((m) => m.type === 'cash_in').reduce((s, m) => s + m.amount, 0);
  const cashOut = movements.filter((m) => m.type === 'cash_out').reduce((s, m) => s + m.amount, 0);
  const deposits = movements.filter((m) => m.type === 'deposit').reduce((s, m) => s + m.amount, 0);
  return { cashIn, cashOut, deposits };
}

/**
 * Computes expected cash/transfer for a shift per the spec B9 formula:
 * opening float + cash sales (change already netted) − cash refunds +
 * cash-in − cash-out − deposits. Online sales never touch the drawer.
 */
export async function computeShiftExpectedTotals(shiftSessionId: string) {
  const shift = await ShiftSession.findById(shiftSessionId);
  if (!shift) throw ApiError.notFound('Shift session not found');

  const id = shift._id;
  const cashSales = await sumPaymentsForShift(id, 'cash');
  const transferSales = (await sumPaymentsForShift(id, 'transfer')) + (await sumPaymentsForShift(id, 'qr'));
  const cashRefunds = await sumRefundsForShift(id, 'cash');
  const transferRefunds = (await sumRefundsForShift(id, 'transfer')) + (await sumRefundsForShift(id, 'qr'));
  const { cashIn, cashOut, deposits } = await sumCashMovements(id);

  const systemCashExpected = shift.openingFloat + cashSales - cashRefunds + cashIn - cashOut - deposits;
  const systemTransferExpected = transferSales - transferRefunds;

  return { systemCashExpected, systemTransferExpected, cashSales, transferSales, cashRefunds, transferRefunds, cashIn, cashOut, deposits };
}

export async function closeShift(input: {
  shiftSessionId: string;
  userId: string;
  closingCashCounted: number;
  closingTransferCounted: number;
  varianceReason?: string;
  carryForwardFloat: number;
  cashHandedIn: number;
}) {
  const shift = await ShiftSession.findById(input.shiftSessionId);
  if (!shift) throw ApiError.notFound('Shift session not found');
  if (shift.status !== 'open') throw ApiError.conflict('Shift is not open');

  // Once the shop uses a stock sheet, a shift cannot close without its "after" count.
  if ((await StockCountGroup.exists({ active: true })) && !(await ShiftStockCount.exists({ shiftSessionId: shift._id, phase: 'close' }))) {
    throw ApiError.badRequest('Count the stock ("Stock หลังขาย") before closing the shift');
  }

  const totals = await computeShiftExpectedTotals(input.shiftSessionId);
  const cashVariance = input.closingCashCounted - totals.systemCashExpected;

  if (cashVariance !== 0 && !input.varianceReason) {
    throw ApiError.badRequest('There is a cash variance — a reason is required to close the shift');
  }

  const expectedHandedInPlusCarry = input.closingCashCounted;
  if (input.carryForwardFloat + input.cashHandedIn !== expectedHandedInPlusCarry) {
    throw ApiError.badRequest('Carry-forward float + cash handed in must equal the counted cash total');
  }

  shift.closedAt = new Date();
  shift.systemCashExpected = totals.systemCashExpected;
  shift.systemTransferExpected = totals.systemTransferExpected;
  shift.closingCashCounted = input.closingCashCounted;
  shift.closingTransferCounted = input.closingTransferCounted;
  shift.cashVariance = cashVariance;
  shift.varianceReason = input.varianceReason;
  shift.carryForwardFloat = input.carryForwardFloat;
  shift.cashHandedIn = input.cashHandedIn;
  shift.status = 'pending_review';
  await shift.save();

  await recordAudit({
    userId: input.userId,
    branchId: shift.branchId,
    action: 'shift.close',
    entityType: 'ShiftSession',
    entityId: shift._id.toString(),
    after: shift.toObject(),
  });

  await notify({
    type: 'shift_pending_review',
    branchId: shift.branchId.toString(),
    payload: { shiftSessionId: shift._id.toString(), cashVariance },
  });
  if (cashVariance !== 0) {
    await notify({
      type: 'shift_cash_variance',
      branchId: shift.branchId.toString(),
      payload: { shiftSessionId: shift._id.toString(), cashVariance },
    });
  }

  return shift;
}

export async function approveShiftClose(shiftSessionId: string, approvedBy: string) {
  const shift = await ShiftSession.findById(shiftSessionId);
  if (!shift) throw ApiError.notFound('Shift session not found');
  if (shift.status !== 'pending_review') throw ApiError.conflict('Shift is not pending review');

  shift.status = 'approved';
  shift.approvedBy = new Types.ObjectId(approvedBy);
  shift.approvedAt = new Date();
  await shift.save();

  await recordAudit({
    userId: approvedBy,
    branchId: shift.branchId,
    action: 'shift.approve',
    entityType: 'ShiftSession',
    entityId: shift._id.toString(),
  });

  await maybeMarkDailySaleClosed(shift.branchId.toString(), shift.openedAt);

  return shift;
}

export async function rejectShiftClose(shiftSessionId: string, rejectedBy: string, reason: string) {
  const shift = await ShiftSession.findById(shiftSessionId);
  if (!shift) throw ApiError.notFound('Shift session not found');
  if (shift.status !== 'pending_review') throw ApiError.conflict('Shift is not pending review');

  shift.status = 'open';
  shift.rejectedReason = reason;
  shift.closedAt = undefined;
  await shift.save();

  await recordAudit({
    userId: rejectedBy,
    branchId: shift.branchId,
    action: 'shift.reject',
    entityType: 'ShiftSession',
    entityId: shift._id.toString(),
    after: { reason },
  });

  return shift;
}

/** Admin-only: reopen an already-approved shift to correct a mistake (spec B9). */
export async function reopenShift(shiftSessionId: string, reopenedBy: string, reason: string) {
  const shift = await ShiftSession.findById(shiftSessionId);
  if (!shift) throw ApiError.notFound('Shift session not found');
  if (shift.status !== 'approved') throw ApiError.conflict('Only an approved shift can be reopened');

  const before = shift.toObject();
  shift.status = 'reopened';
  shift.reopenedBy = new Types.ObjectId(reopenedBy);
  shift.reopenedAt = new Date();
  await shift.save();

  await recordAudit({
    userId: reopenedBy,
    branchId: shift.branchId,
    action: 'shift.reopen',
    entityType: 'ShiftSession',
    entityId: shift._id.toString(),
    before,
    after: shift.toObject(),
    refDoc: reason,
  });

  return shift;
}

/**
 * Daily Sale Closed = every shift session for that branch-day is approved
 * (spec B9, confirmed default). Recorded as a DailySales doc for fast
 * dashboard/report reads.
 */
export async function maybeMarkDailySaleClosed(branchId: string, anyDateInDay: Date) {
  const { DailySales } = await import('../models/DailySales');
  const dayStart = startOfDay(anyDateInDay);
  const dayEnd = endOfDay(anyDateInDay);

  const sessionsThatDay = await ShiftSession.find({
    branchId,
    openedAt: { $gte: dayStart, $lte: dayEnd },
  });
  if (sessionsThatDay.length === 0) return;

  const allApproved = sessionsThatDay.every((s) => s.status === 'approved');

  await DailySales.findOneAndUpdate(
    { branchId, date: dayStart },
    { $set: { closedStatus: allApproved ? 'closed' : 'partial' } },
    { upsert: true },
  );

  if (allApproved) {
    await notify({ type: 'daily_sale_closed', branchId, payload: { date: dayStart.toISOString() } });
  }
}

export interface ShiftBillLine {
  skuId: Types.ObjectId;
  qty: number;
  unitPriceAtSale: number;
  discountApplied: number;
  lineTotal: number;
  priceOverrideReason?: string;
  oversoldQty?: number;
}
export interface ShiftBill {
  id: string;
  source: 'pos' | 'online_order';
  channel: string;
  bucket: SalesBucket;
  createdAt: Date;
  soldBy: string | null;
  subtotal: number;
  discountTotal: number;
  netTotal: number;
  lines: ShiftBillLine[];
  payments: { method: string; amount: number }[];
}

/**
 * Every bill that belongs to a shift, newest first: completed POS sales plus
 * online (chat) orders logged while the shift was open, minus cancelled ones.
 */
export async function loadShiftBills(shiftSessionId: Types.ObjectId | string): Promise<ShiftBill[]> {
  const sales = await Sale.find({ shiftSessionId, status: 'completed' }).populate<{ soldBy: { name: string } | null }>('soldBy', 'name');
  const orders = await Order.find({ shiftSessionId, orderStatus: { $ne: 'cancelled' } }).populate<{ createdBy: { name: string } | null }>('createdBy', 'name');
  const saleItems = await SaleItem.find({ saleId: { $in: sales.map((s) => s._id) } });
  const orderItems = await OrderItem.find({ orderId: { $in: orders.map((o) => o._id) } });
  const payments = await Payment.find({
    $or: [
      { parentType: 'Sale', parentId: { $in: sales.map((s) => s._id) } },
      { parentType: 'Order', parentId: { $in: orders.map((o) => o._id) } },
    ],
  });

  const group = <T>(rows: T[], key: (r: T) => string) => {
    const map = new Map<string, T[]>();
    for (const r of rows) {
      const k = key(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    return map;
  };
  const toLine = (i: ShiftBillLine): ShiftBillLine => ({
    skuId: i.skuId,
    qty: i.qty,
    unitPriceAtSale: i.unitPriceAtSale,
    discountApplied: i.discountApplied,
    lineTotal: i.lineTotal,
    priceOverrideReason: i.priceOverrideReason,
    oversoldQty: i.oversoldQty,
  });
  // Plain objects, so callers can spread them.
  const linesBySale = group(saleItems.map((i) => ({ parent: i.saleId.toString(), line: toLine(i) })), (x) => x.parent);
  const linesByOrder = group(orderItems.map((i) => ({ parent: i.orderId.toString(), line: toLine(i) })), (x) => x.parent);
  const linesOf = (map: Map<string, { line: ShiftBillLine }[]>, id: string) => (map.get(id) ?? []).map((x) => x.line);
  const paymentsByParent = group(payments, (p) => p.parentId.toString());
  const pay = (id: string) => (paymentsByParent.get(id) ?? []).map((p) => ({ method: p.method, amount: p.amount }));

  const bills: ShiftBill[] = [
    ...sales.map((s) => ({
      id: s._id.toString(),
      source: 'pos' as const,
      channel: s.channel ?? 'store',
      bucket: salesBucket(s.channel),
      createdAt: s.createdAt,
      soldBy: s.soldBy?.name ?? null,
      subtotal: s.subtotal,
      discountTotal: s.discountTotal,
      netTotal: s.netTotal,
      lines: linesOf(linesBySale, s._id.toString()),
      payments: pay(s._id.toString()),
    })),
    ...orders.map((o) => ({
      id: o._id.toString(),
      source: 'online_order' as const,
      channel: o.channel,
      bucket: salesBucket(o.channel),
      createdAt: o.createdAt,
      soldBy: o.createdBy?.name ?? null,
      subtotal: o.subtotal,
      discountTotal: o.discountTotal,
      netTotal: o.netTotal,
      lines: linesOf(linesByOrder, o._id.toString()),
      payments: pay(o._id.toString()),
    })),
  ];
  return bills.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
}

/** Money per bucket (หน้าร้าน / Grab / Online) and the combined total. */
export function sumByBucket(bills: ShiftBill[]) {
  const byBucket: Record<SalesBucket, number> = { store: 0, grab: 0, online: 0 };
  for (const b of bills) byBucket[b.bucket] += b.netTotal;
  return { byBucket, total: byBucket.store + byBucket.grab + byBucket.online };
}

/**
 * What has been sold so far in a shift, product by product (and SKU by SKU),
 * plus the bill list — the cashier's "ขายอะไรไปแล้วบ้าง" view. Includes online
 * orders linked to the shift, kept apart as the "online" bucket. Amounts are
 * line totals before cart-level discounts; bill totals are what was charged.
 */
export async function getShiftSoldItems(shiftSessionId: string) {
  const shift = await ShiftSession.findById(shiftSessionId, { _id: 1 });
  if (!shift) throw ApiError.notFound('Shift session not found');

  const bills = await loadShiftBills(shift._id);
  const allLines = bills.flatMap((b) => b.lines);
  const skus = await ProductSku.find({ _id: { $in: allLines.map((i) => i.skuId) } }).populate<{ productId: { _id: Types.ObjectId; name: string; type: string } | null }>(
    'productId',
    'name type',
  );
  const skuMap = new Map(skus.map((s) => [s._id.toString(), s]));
  const variants = await ProductVariant.find({ _id: { $in: skus.map((s) => s.variantId).filter(Boolean) } }, { colorName: 1 });
  const colorMap = new Map(variants.map((v) => [v._id.toString(), v.colorName]));

  type BucketQty = Record<SalesBucket, number>;
  type SkuRow = { skuId: string; skuCode: string; colorName: string | null; power: number | null; qty: number; giveawayQty: number; amount: number; qtyByBucket: BucketQty };
  type ProductRow = { productId: string | null; productName: string; isLens: boolean; qty: number; giveawayQty: number; amount: number; qtyByBucket: BucketQty; skus: SkuRow[] };
  const products = new Map<string, ProductRow>();
  const skuRows = new Map<string, SkuRow>();
  const describe = (skuId: Types.ObjectId) => {
    const sku = skuMap.get(skuId.toString());
    const product = sku?.productId ?? null;
    return {
      sku,
      product,
      colorName: sku?.variantId ? (colorMap.get(sku.variantId.toString()) ?? null) : null,
      power: sku?.power ?? null,
    };
  };

  for (const bill of bills) {
    for (const item of bill.lines) {
      const { sku, product, colorName, power } = describe(item.skuId);
      const productKey = product?._id.toString() ?? 'unknown';
      const isGiveaway = item.unitPriceAtSale === 0;

      if (!products.has(productKey)) {
        products.set(productKey, {
          productId: product?._id.toString() ?? null,
          productName: product?.name ?? 'สินค้าที่ถูกลบ',
          isLens: product?.type === 'contact_lens',
          qty: 0,
          giveawayQty: 0,
          amount: 0,
          qtyByBucket: { store: 0, grab: 0, online: 0 },
          skus: [],
        });
      }
      const p = products.get(productKey)!;
      p.qty += item.qty;
      p.amount += item.lineTotal;
      p.qtyByBucket[bill.bucket] += item.qty;
      if (isGiveaway) p.giveawayQty += item.qty;

      const skuKey = item.skuId.toString();
      if (!skuRows.has(skuKey)) {
        const row: SkuRow = { skuId: skuKey, skuCode: sku?.skuCode ?? '-', colorName, power, qty: 0, giveawayQty: 0, amount: 0, qtyByBucket: { store: 0, grab: 0, online: 0 } };
        skuRows.set(skuKey, row);
        p.skus.push(row);
      }
      const r = skuRows.get(skuKey)!;
      r.qty += item.qty;
      r.amount += item.lineTotal;
      r.qtyByBucket[bill.bucket] += item.qty;
      if (isGiveaway) r.giveawayQty += item.qty;
    }
  }

  const productRows = [...products.values()]
    .map((p) => ({
      ...p,
      skus: p.skus.sort((a, b) => (a.colorName ?? '').localeCompare(b.colorName ?? '') || (a.power ?? 0) - (b.power ?? 0) || a.skuCode.localeCompare(b.skuCode)),
    }))
    .sort((a, b) => Number(b.isLens) - Number(a.isLens) || b.qty - a.qty || a.productName.localeCompare(b.productName));

  const { byBucket, total } = sumByBucket(bills);
  return {
    products: productRows,
    bills: bills.map((b) => ({
      saleId: b.id,
      source: b.source,
      createdAt: b.createdAt,
      channel: b.channel,
      bucket: b.bucket,
      soldBy: b.soldBy,
      subtotal: b.subtotal,
      discountTotal: b.discountTotal,
      netTotal: b.netTotal,
      items: b.lines.map((item) => {
        const { sku, product, colorName, power } = describe(item.skuId);
        return {
          skuCode: sku?.skuCode ?? '-',
          productName: product?.name ?? 'สินค้าที่ถูกลบ',
          colorName,
          power,
          qty: item.qty,
          unitPrice: item.unitPriceAtSale,
          lineTotal: item.lineTotal,
          overrideReason: item.priceOverrideReason ?? null,
        };
      }),
      payments: b.payments,
    })),
    totals: {
      saleCount: bills.length,
      itemQty: productRows.reduce((sum, p) => sum + p.qty, 0),
      lensQty: productRows.filter((p) => p.isLens).reduce((sum, p) => sum + p.qty, 0),
      giveawayQty: productRows.reduce((sum, p) => sum + p.giveawayQty, 0),
      byBucket,
      netTotal: total,
    },
  };
}
