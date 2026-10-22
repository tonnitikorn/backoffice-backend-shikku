import { Types } from 'mongoose';
import { Sale } from '../models/Sale';
import { SaleItem } from '../models/SaleItem';
import { Order } from '../models/Order';
import { Payment } from '../models/Payment';
import { Refund } from '../models/Refund';
import { Expense } from '../models/Expense';
import { Inventory } from '../models/Inventory';
import { InventoryTransaction } from '../models/InventoryTransaction';
import { ProductSku } from '../models/ProductSku';
import { ShiftSession } from '../models/ShiftSession';
import { StockTransfer } from '../models/StockTransfer';
import { getSetting } from './settingsService';
import { SETTING_KEYS } from '../models/Setting';

function dayRangeFilter(from?: Date, to?: Date) {
  const filter: Record<string, unknown> = {};
  if (from || to) {
    filter.createdAt = {};
    if (from) (filter.createdAt as Record<string, Date>).$gte = from;
    if (to) (filter.createdAt as Record<string, Date>).$lte = to;
  }
  return filter;
}

/** Spec item 14: daily summary — store vs online, discounts, refunds, net, cash/transfer split. */
export async function getDailySummary(branchId: string | undefined, date: Date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const saleFilter: Record<string, unknown> = { status: 'completed', createdAt: { $gte: dayStart, $lte: dayEnd } };
  if (branchId) saleFilter.branchId = new Types.ObjectId(branchId);
  const sales = await Sale.find(saleFilter);
  const saleIds = sales.map((s) => s._id);

  const orderFilter: Record<string, unknown> = { createdAt: { $gte: dayStart, $lte: dayEnd } };
  if (branchId) orderFilter.branchId = new Types.ObjectId(branchId);
  const orders = await Order.find({ ...orderFilter, orderStatus: { $ne: 'cancelled' } });

  const storeSales = sales.reduce((s, x) => s + x.netTotal, 0);
  const onlineSales = orders.reduce((s, x) => s + x.netTotal, 0);
  const discountTotal = sales.reduce((s, x) => s + x.discountTotal, 0) + orders.reduce((s, x) => s + x.discountTotal, 0);

  const refundFilter: Record<string, unknown> = { status: 'approved', createdAt: { $gte: dayStart, $lte: dayEnd } };
  if (branchId) refundFilter.branchId = new Types.ObjectId(branchId);
  const refunds = await Refund.find(refundFilter);
  const refundTotal = refunds.reduce((s, r) => s + r.totalRefundAmount, 0);

  const payments = await Payment.find({ parentType: 'Sale', parentId: { $in: saleIds } });
  const cash = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount, 0);
  const transfer = payments.filter((p) => p.method !== 'cash').reduce((s, p) => s + p.amount, 0);

  return {
    date: dayStart,
    saleCount: sales.length,
    orderCount: orders.length,
    storeSales,
    onlineSales,
    grossSales: storeSales + onlineSales,
    discountTotal,
    refundTotal,
    netTotal: storeSales + onlineSales - refundTotal,
    cash,
    transfer,
  };
}

export async function getSalesReport(params: { branchId?: string; from: Date; to: Date; groupBy: 'day' | 'week' | 'month' | 'shift' | 'staff' }) {
  const match: Record<string, unknown> = { status: 'completed', createdAt: { $gte: params.from, $lte: params.to } };
  if (params.branchId) match.branchId = new Types.ObjectId(params.branchId);

  let groupId: Record<string, unknown>;
  switch (params.groupBy) {
    case 'shift':
      groupId = { shiftSessionId: '$shiftSessionId' };
      break;
    case 'staff':
      groupId = { soldBy: '$soldBy' };
      break;
    case 'week':
      groupId = { year: { $isoWeekYear: '$createdAt' }, week: { $isoWeek: '$createdAt' } };
      break;
    case 'month':
      groupId = { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } };
      break;
    default:
      groupId = { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } };
  }

  return Sale.aggregate([
    { $match: match },
    { $group: { _id: groupId, saleCount: { $sum: 1 }, netTotal: { $sum: '$netTotal' }, discountTotal: { $sum: '$discountTotal' } } },
    { $sort: { _id: 1 } },
  ]);
}

/**
 * Store sales over a date range, broken down per shift session. `shiftDefinitionId`
 * narrows to one shift template (e.g. morning shift); 'unscheduled' picks sessions
 * opened without one.
 */
export async function getShiftSalesReport(params: { branchId?: string; from: Date; to: Date; shiftDefinitionId?: string }) {
  const match: Record<string, unknown> = { status: 'completed', createdAt: { $gte: params.from, $lte: params.to } };
  if (params.branchId) match.branchId = new Types.ObjectId(params.branchId);
  if (params.shiftDefinitionId) {
    const sessionFilter =
      params.shiftDefinitionId === 'unscheduled'
        ? { shiftDefinitionId: { $exists: false } }
        : { shiftDefinitionId: new Types.ObjectId(params.shiftDefinitionId) };
    match.shiftSessionId = { $in: await ShiftSession.find(sessionFilter).distinct('_id') };
  }

  const saleRows = await Sale.aggregate<{ _id: Types.ObjectId; saleCount: number; subtotal: number; discountTotal: number; netTotal: number; saleIds: Types.ObjectId[] }>([
    { $match: match },
    {
      $group: {
        _id: '$shiftSessionId',
        saleCount: { $sum: 1 },
        subtotal: { $sum: '$subtotal' },
        discountTotal: { $sum: '$discountTotal' },
        netTotal: { $sum: '$netTotal' },
        saleIds: { $push: '$_id' },
      },
    },
  ]);
  const sessionIds = saleRows.map((r) => r._id);

  const paymentRows = await Payment.aggregate<{ _id: { parentId: Types.ObjectId; method: string }; amount: number }>([
    { $match: { parentType: 'Sale', parentId: { $in: saleRows.flatMap((r) => r.saleIds) } } },
    { $group: { _id: { parentId: '$parentId', method: '$method' }, amount: { $sum: '$amount' } } },
  ]);
  const saleToSession = new Map<string, string>();
  for (const r of saleRows) for (const id of r.saleIds) saleToSession.set(id.toString(), r._id.toString());
  const paymentsBySession = new Map<string, { cash: number; transfer: number; qr: number; platform: number }>();
  for (const p of paymentRows) {
    const key = saleToSession.get(p._id.parentId.toString())!;
    if (!paymentsBySession.has(key)) paymentsBySession.set(key, { cash: 0, transfer: 0, qr: 0, platform: 0 });
    const entry = paymentsBySession.get(key)!;
    entry[p._id.method as keyof typeof entry] += p.amount;
  }

  const refundRows = await Refund.aggregate<{ _id: Types.ObjectId; refundTotal: number }>([
    { $match: { status: 'approved', shiftSessionId: { $in: sessionIds }, createdAt: { $gte: params.from, $lte: params.to } } },
    { $group: { _id: '$shiftSessionId', refundTotal: { $sum: '$totalRefundAmount' } } },
  ]);
  const refundBySession = new Map(refundRows.map((r) => [r._id.toString(), r.refundTotal]));

  const sessions = await ShiftSession.find({ _id: { $in: sessionIds } })
    .populate('userId', 'name')
    .populate('branchId', 'name')
    .populate('shiftDefinitionId', 'name startTime endTime');
  const sessionMap = new Map(sessions.map((s) => [s._id.toString(), s]));

  const rows = saleRows
    .map((r) => {
      const key = r._id.toString();
      const session = sessionMap.get(key);
      const payments = paymentsBySession.get(key) ?? { cash: 0, transfer: 0, qr: 0, platform: 0 };
      const refundTotal = refundBySession.get(key) ?? 0;
      return {
        shiftSessionId: key,
        branch: session?.branchId ?? null,
        user: session?.userId ?? null,
        shiftDefinition: session?.shiftDefinitionId ?? null,
        openedAt: session?.openedAt ?? null,
        closedAt: session?.closedAt ?? null,
        status: session?.status ?? null,
        saleCount: r.saleCount,
        subtotal: r.subtotal,
        discountTotal: r.discountTotal,
        netTotal: r.netTotal,
        refundTotal,
        netAfterRefund: r.netTotal - refundTotal,
        ...payments,
      };
    })
    .sort((a, b) => (a.openedAt?.getTime() ?? 0) - (b.openedAt?.getTime() ?? 0));

  const summary = rows.reduce(
    (acc, r) => {
      acc.shiftCount += 1;
      acc.saleCount += r.saleCount;
      acc.subtotal += r.subtotal;
      acc.discountTotal += r.discountTotal;
      acc.netTotal += r.netTotal;
      acc.refundTotal += r.refundTotal;
      acc.netAfterRefund += r.netAfterRefund;
      acc.cash += r.cash;
      acc.transfer += r.transfer;
      acc.qr += r.qr;
      acc.platform += r.platform;
      return acc;
    },
    { shiftCount: 0, saleCount: 0, subtotal: 0, discountTotal: 0, netTotal: 0, refundTotal: 0, netAfterRefund: 0, cash: 0, transfer: 0, qr: 0, platform: 0 },
  );

  return { summary, rows };
}

/** Best/worst sellers by qty and revenue, with remaining stock (spec item 17). */
export async function getProductPerformanceReport(params: { branchId?: string; from: Date; to: Date }) {
  const saleMatch: Record<string, unknown> = { status: 'completed', createdAt: { $gte: params.from, $lte: params.to } };
  if (params.branchId) saleMatch.branchId = new Types.ObjectId(params.branchId);

  const saleIds = await Sale.find(saleMatch).distinct('_id');

  const rows = await SaleItem.aggregate([
    { $match: { saleId: { $in: saleIds } } },
    { $group: { _id: '$skuId', qtySold: { $sum: '$qty' }, revenue: { $sum: '$lineTotal' } } },
    { $sort: { qtySold: -1 } },
    { $limit: 100 },
  ]);

  const skus = await ProductSku.find({ _id: { $in: rows.map((r) => r._id) } }).populate('productId');
  const skuMap = new Map(skus.map((s) => [s._id.toString(), s]));

  const inventoryFilter: Record<string, unknown> = { skuId: { $in: rows.map((r) => r._id) } };
  if (params.branchId) inventoryFilter.branchId = new Types.ObjectId(params.branchId);
  const inventories = await Inventory.find(inventoryFilter);
  const qtyMap = new Map<string, number>();
  for (const inv of inventories) qtyMap.set(inv.skuId.toString(), (qtyMap.get(inv.skuId.toString()) ?? 0) + inv.qtyOnHand);

  return rows.map((r) => ({
    sku: skuMap.get(r._id.toString()),
    qtySold: r.qtySold,
    revenue: r.revenue,
    qtyOnHand: qtyMap.get(r._id.toString()) ?? 0,
  }));
}

/** Profit = revenue - cost of goods - discounts - recorded expenses (spec item 17). */
export async function getProfitReport(params: { branchId?: string; from: Date; to: Date }) {
  const saleMatch: Record<string, unknown> = { status: 'completed', createdAt: { $gte: params.from, $lte: params.to } };
  if (params.branchId) saleMatch.branchId = new Types.ObjectId(params.branchId);
  const saleIds = await Sale.find(saleMatch).distinct('_id');

  const itemAgg = await SaleItem.aggregate([
    { $match: { saleId: { $in: saleIds } } },
    {
      $group: {
        _id: null,
        revenue: { $sum: '$lineTotal' },
        cost: { $sum: { $multiply: ['$unitCostAtSale', '$qty'] } },
      },
    },
  ]);
  const revenue = itemAgg[0]?.revenue ?? 0;
  const cogs = itemAgg[0]?.cost ?? 0;

  const sales = await Sale.find(saleMatch);
  const discountTotal = sales.reduce((s, x) => s + x.discountTotal, 0);

  const expenseFilter: Record<string, unknown> = { date: { $gte: params.from, $lte: params.to } };
  if (params.branchId) expenseFilter.branchId = new Types.ObjectId(params.branchId);
  const expenses = await Expense.find(expenseFilter);
  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0);

  const refundFilter: Record<string, unknown> = { status: 'approved', createdAt: { $gte: params.from, $lte: params.to } };
  if (params.branchId) refundFilter.branchId = new Types.ObjectId(params.branchId);
  const refunds = await Refund.find(refundFilter);
  const lostToWriteOff = 0; // write-off cost value could be added by joining RefundItem -> sku.cost if needed later
  const refundTotal = refunds.reduce((s, r) => s + r.totalRefundAmount, 0);

  const grossProfit = revenue - cogs - discountTotal;
  const netProfit = grossProfit - expenseTotal - refundTotal;

  return { revenue, cogs, discountTotal, expenseTotal, refundTotal, lostToWriteOff, grossProfit, netProfit };
}

/** Expiring stock report (spec B11), sorted soonest-first. */
export async function getExpiryReport(branchId?: string) {
  const expiryWarningDays = await getSetting<number>(SETTING_KEYS.expiryWarningDays);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + expiryWarningDays);

  const match: Record<string, unknown> = { expiryDate: { $lte: cutoff, $ne: null } };
  if (branchId) match.branchId = new Types.ObjectId(branchId);

  const rows = await InventoryTransaction.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    { $group: { _id: { branchId: '$branchId', skuId: '$skuId', lot: '$lot' }, expiryDate: { $first: '$expiryDate' }, lastBalance: { $first: '$balanceAfter' } } },
    { $match: { lastBalance: { $gt: 0 } } },
    { $sort: { expiryDate: 1 } },
  ]);

  const now = new Date();
  return rows.map((r) => ({
    branchId: r._id.branchId,
    skuId: r._id.skuId,
    lot: r._id.lot,
    expiryDate: r.expiryDate,
    qtyRemaining: r.lastBalance,
    daysRemaining: Math.ceil((new Date(r.expiryDate).getTime() - now.getTime()) / 86400000),
  }));
}

/** Dead-stock report (spec B11): no sale in N days, cost value only shown to cost-viewers by the controller. */
export async function getDeadStockReport(branchId?: string) {
  const deadStockDays = await getSetting<number>(SETTING_KEYS.deadStockDays);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - deadStockDays);

  const invFilter: Record<string, unknown> = { qtyOnHand: { $gt: 0 } };
  if (branchId) invFilter.branchId = new Types.ObjectId(branchId);
  const inventories = await Inventory.find(invFilter).populate('skuId');

  const results = [];
  for (const inv of inventories) {
    const lastSale = await InventoryTransaction.findOne({ branchId: inv.branchId, skuId: inv.skuId, type: 'sale_out' }).sort({ createdAt: -1 });
    const lastSaleDate = lastSale?.createdAt;
    if (!lastSaleDate || lastSaleDate <= cutoff) {
      results.push({
        branchId: inv.branchId,
        sku: inv.skuId,
        qtyOnHand: inv.qtyOnHand,
        lastSaleDate: lastSaleDate ?? null,
        daysSinceLastSale: lastSaleDate ? Math.floor((Date.now() - lastSaleDate.getTime()) / 86400000) : null,
      });
    }
  }
  return results;
}

/** Cash variance by employee (spec B11) — admin/branch manager only. */
export async function getCashVarianceReport(params: { branchId?: string; from: Date; to: Date }) {
  const filter: Record<string, unknown> = { status: 'approved', closedAt: { $gte: params.from, $lte: params.to } };
  if (params.branchId) filter.branchId = new Types.ObjectId(params.branchId);

  const sessions = await ShiftSession.find(filter).populate('userId branchId').sort({ closedAt: -1 });
  const byUser = new Map<string, { userId: string; totalVariance: number; sessions: number }>();
  for (const s of sessions) {
    const key = s.userId._id.toString();
    if (!byUser.has(key)) byUser.set(key, { userId: key, totalVariance: 0, sessions: 0 });
    const entry = byUser.get(key)!;
    entry.totalVariance += s.cashVariance ?? 0;
    entry.sessions += 1;
  }

  return { sessions, summaryByUser: Array.from(byUser.values()) };
}

/** Sales by hour-of-day / day-of-week / day-of-month, split by branch and channel (spec B11). */
export async function getSalesByTimeReport(params: { branchId?: string; from: Date; to: Date; granularity: 'hour' | 'weekday' | 'dayOfMonth' }) {
  const match: Record<string, unknown> = { status: 'completed', createdAt: { $gte: params.from, $lte: params.to } };
  if (params.branchId) match.branchId = new Types.ObjectId(params.branchId);

  const dateExpr =
    params.granularity === 'hour' ? { $hour: '$createdAt' } : params.granularity === 'weekday' ? { $dayOfWeek: '$createdAt' } : { $dayOfMonth: '$createdAt' };

  return Sale.aggregate([
    { $match: match },
    { $group: { _id: { bucket: dateExpr, branchId: '$branchId' }, saleCount: { $sum: 1 }, netTotal: { $sum: '$netTotal' } } },
    { $sort: { '_id.bucket': 1 } },
  ]);
}

export async function getPendingTransferCount(branchId?: string) {
  const filter: Record<string, unknown> = { status: { $in: ['sent', 'in_transit'] } };
  if (branchId) filter.$or = [{ fromBranchId: branchId }, { toBranchId: branchId }];
  return StockTransfer.countDocuments(filter);
}

export { dayRangeFilter };
