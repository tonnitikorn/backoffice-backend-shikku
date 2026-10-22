import { Types } from 'mongoose';
import { StockCountGroup, IStockCountGroup, PowerFilter } from '../models/StockCountGroup';
import { ShiftStockCount, StockCountPhase } from '../models/ShiftStockCount';
import { ShiftSession } from '../models/ShiftSession';
import { Product } from '../models/Product';
import { ProductSku, IProductSku } from '../models/ProductSku';
import { Inventory } from '../models/Inventory';
import { InventoryTransaction } from '../models/InventoryTransaction';
import { Refund } from '../models/Refund';
import { ApiError } from '../utils/ApiError';
import { recordAudit } from './auditService';
import { computeShiftExpectedTotals, loadShiftBills, sumByBucket } from './shiftService';

type SkuLike = Pick<IProductSku, '_id' | 'productId' | 'power'>;

function matchesPower(filter: PowerFilter, power: number | undefined | null) {
  const plano = power === undefined || power === null || power === 0;
  if (filter === 'plano') return plano;
  if (filter === 'non_plano') return !plano;
  return true;
}

export async function getActiveGroups() {
  return StockCountGroup.find({ active: true }).sort({ sortOrder: 1, name: 1 });
}

/** Maps a SKU to the first active group (by sortOrder) whose products and power filter match it. */
export function buildGroupResolver(groups: IStockCountGroup[]) {
  const byProduct = new Map<string, IStockCountGroup[]>();
  for (const g of groups) {
    for (const pid of g.productIds) {
      const key = pid.toString();
      if (!byProduct.has(key)) byProduct.set(key, []);
      byProduct.get(key)!.push(g);
    }
  }
  return (sku: SkuLike): IStockCountGroup | null => {
    for (const g of byProduct.get(sku.productId.toString()) ?? []) {
      if (matchesPower(g.powerFilter, sku.power)) return g;
    }
    return null;
  };
}

/** Ledger quantity per group at a branch right now. */
export async function getSystemQtyByGroup(branchId: string | Types.ObjectId, groups: IStockCountGroup[]) {
  const resolve = buildGroupResolver(groups);
  const productIds = [...new Set(groups.flatMap((g) => g.productIds.map((id) => id.toString())))];
  const skus = await ProductSku.find({ productId: { $in: productIds } }, { productId: 1, power: 1 });
  const skuGroup = new Map<string, string>();
  for (const sku of skus) {
    const g = resolve(sku);
    if (g) skuGroup.set(sku._id.toString(), g._id.toString());
  }
  const inventories = await Inventory.find({ branchId, skuId: { $in: [...skuGroup.keys()] } }, { skuId: 1, qtyOnHand: 1 });
  const qty = new Map<string, number>(groups.map((g) => [g._id.toString(), 0]));
  for (const inv of inventories) {
    const gid = skuGroup.get(inv.skuId.toString())!;
    qty.set(gid, (qty.get(gid) ?? 0) + inv.qtyOnHand);
  }
  return qty;
}

export async function recordShiftStockCount(input: {
  shiftSessionId: string;
  phase: StockCountPhase;
  lines: { groupId: string; countedQty: number }[];
  note?: string;
  userId: string;
}) {
  const shift = await ShiftSession.findById(input.shiftSessionId);
  if (!shift) throw ApiError.notFound('Shift session not found');
  if (shift.status !== 'open') throw ApiError.conflict('Stock can only be counted while the shift is open');

  const groups = await getActiveGroups();
  if (groups.length === 0) throw ApiError.badRequest('No stock count groups are set up yet');
  const counted = new Map(input.lines.map((l) => [l.groupId, l.countedQty]));
  const missing = groups.filter((g) => !counted.has(g._id.toString()));
  if (missing.length > 0) throw ApiError.badRequest(`Please count every group — missing: ${missing.map((g) => g.name).join(', ')}`);

  const systemQty = await getSystemQtyByGroup(shift.branchId, groups);
  const lines = groups.map((g) => ({
    groupId: g._id,
    groupName: g.name,
    countedQty: counted.get(g._id.toString())!,
    systemQty: systemQty.get(g._id.toString()) ?? 0,
  }));

  // Recounting before the shift closes replaces the earlier count.
  const doc = await ShiftStockCount.findOneAndUpdate(
    { shiftSessionId: shift._id, phase: input.phase },
    { $set: { branchId: shift.branchId, lines, note: input.note, countedBy: input.userId, countedAt: new Date() } },
    { upsert: true, new: true },
  );

  const variances = lines.filter((l) => l.countedQty !== l.systemQty).map((l) => ({ group: l.groupName, counted: l.countedQty, system: l.systemQty }));
  const handover = input.phase === 'open' ? await getHandover(shift._id) : null;
  await recordAudit({
    userId: input.userId,
    branchId: shift.branchId,
    action: `shift.stock_count_${input.phase}`,
    entityType: 'ShiftSession',
    entityId: shift._id.toString(),
    after: { variances, handoverMismatches: handover?.lines.filter((l) => l.diff) ?? [] },
  });

  return { doc, handover };
}

const UNIT_LABEL: Record<string, string> = { pair: 'คู่', piece: 'ชิ้น', bottle: 'ขวด', box: 'กล่อง', set: 'ชุด' };

function mode(values: number[]) {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const baht = (satang: number | undefined) => (satang === undefined ? '' : ` ${Math.round(satang / 100)}฿`);

/**
 * First-time setup matching the shop's paper stock sheet: the cheap fashion
 * lenses sold per model are counted together as "ปกติ" (power 0) and "สายตา"
 * (other powers); every other lens line is counted per category (or per
 * product when uncategorised); accessories are counted per product.
 */
export async function createDefaultGroups(userId: string) {
  if (await StockCountGroup.exists({})) throw ApiError.conflict('Stock count groups already exist — edit them instead');

  const products = await Product.find({ active: true }).populate<{ categoryId: { _id: Types.ObjectId; name: string } | null }>('categoryId', 'name');
  const skus = await ProductSku.find({ productId: { $in: products.map((p) => p._id) }, active: true }, { productId: 1, power: 1, priceRegular: 1 });
  const skusByProduct = new Map<string, typeof skus>();
  for (const s of skus) {
    const key = s.productId.toString();
    if (!skusByProduct.has(key)) skusByProduct.set(key, []);
    skusByProduct.get(key)!.push(s);
  }

  const lenses = products.filter((p) => p.type === 'contact_lens');
  const budgetPrice = mode(lenses.map((p) => p.defaultPriceRegular));
  const budget = lenses.filter((p) => p.defaultPriceRegular === budgetPrice || /อื่นๆ (ปกติ|สายตา)/.test(p.name));
  const budgetSkus = budget.flatMap((p) => skusByProduct.get(p._id.toString()) ?? []);
  const planoPrice = mode(budgetSkus.filter((s) => matchesPower('plano', s.power)).map((s) => s.priceRegular));
  const powerPrice = mode(budgetSkus.filter((s) => matchesPower('non_plano', s.power)).map((s) => s.priceRegular));

  const drafts: { name: string; productIds: Types.ObjectId[]; powerFilter: PowerFilter; unitLabel: string; price: number; lens: boolean }[] = [];
  if (budget.length > 0) {
    const ids = budget.map((p) => p._id);
    drafts.push({ name: `สายตาปกติ${baht(planoPrice)}`, productIds: ids, powerFilter: 'plano', unitLabel: 'คู่', price: -2, lens: true });
    drafts.push({ name: `สายตาสั้น${baht(powerPrice)}`, productIds: ids, powerFilter: 'non_plano', unitLabel: 'คู่', price: -1, lens: true });
  }

  const budgetIds = new Set(budget.map((p) => p._id.toString()));
  const byCategory = new Map<string, typeof products>();
  for (const p of lenses.filter((l) => !budgetIds.has(l._id.toString()))) {
    const key = p.categoryId ? `cat:${p.categoryId._id}` : `prod:${p._id}`;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(p);
  }
  for (const group of byCategory.values()) {
    const price = mode(group.map((p) => p.defaultPriceRegular)) ?? 0;
    const name = group.length === 1 ? group[0].name : group[0].categoryId!.name;
    drafts.push({ name: `${name}${baht(price)}`, productIds: group.map((p) => p._id), powerFilter: 'any', unitLabel: 'คู่', price, lens: true });
  }
  for (const p of products.filter((x) => x.type !== 'contact_lens')) {
    drafts.push({ name: `${p.name}${baht(p.defaultPriceRegular)}`, productIds: [p._id], powerFilter: 'any', unitLabel: UNIT_LABEL[p.unitOfMeasure] ?? 'ชิ้น', price: p.defaultPriceRegular, lens: false });
  }

  drafts.sort((a, b) => Number(b.lens) - Number(a.lens) || a.price - b.price || a.name.localeCompare(b.name, 'th'));
  const created = await StockCountGroup.insertMany(
    drafts.map((d, i) => ({ name: d.name, productIds: d.productIds, powerFilter: d.powerFilter, unitLabel: d.unitLabel, sortOrder: (i + 1) * 10 })),
  );

  await recordAudit({ userId, action: 'stock_count_group.bootstrap', entityType: 'StockCountGroup', after: { count: created.length } });
  return created;
}

/** Active products that no group picks up, so admin can see what the stock sheet is missing. */
export async function getUngroupedProducts() {
  const groups = await getActiveGroups();
  const grouped = new Set(groups.flatMap((g) => g.productIds.map((id) => id.toString())));
  return Product.find({ active: true, _id: { $nin: [...grouped] } }, { name: 1, type: 1, defaultPriceRegular: 1 }).sort({ name: 1 });
}

const INCOMING_TYPES = ['purchase_in', 'transfer_in', 'adjustment_increase', 'return_in', 'reversal'];

type GroupMovement = { saleOut: number; stockIn: number; otherOut: number };

/** Ledger movements per group at a branch in (from, to]. */
async function movementByGroup(branchId: Types.ObjectId | string, from: Date, to: Date, resolve: ReturnType<typeof buildGroupResolver>) {
  const txns = await InventoryTransaction.find({ branchId, createdAt: { $gt: from, $lte: to } }, { skuId: 1, type: 1, qtyChange: 1 });
  const txnSkus = await ProductSku.find({ _id: { $in: [...new Set(txns.map((t) => t.skuId.toString()))] } }, { productId: 1, power: 1 });
  const txnSkuGroup = new Map(txnSkus.map((s) => [s._id.toString(), resolve(s)?._id.toString()]));
  const movement = new Map<string, GroupMovement>();
  for (const t of txns) {
    const gid = txnSkuGroup.get(t.skuId.toString());
    if (!gid) continue;
    if (!movement.has(gid)) movement.set(gid, { saleOut: 0, stockIn: 0, otherOut: 0 });
    const m = movement.get(gid)!;
    if (t.type === 'sale_out') m.saleOut += -t.qtyChange;
    else if (INCOMING_TYPES.includes(t.type) && t.qtyChange > 0) m.stockIn += t.qtyChange;
    else m.otherOut += -t.qtyChange;
  }
  return movement;
}

/** The most recent earlier shift at the same branch that recorded a "Stock หลังขาย" count. */
async function findPreviousClose(shift: { branchId: Types.ObjectId; openedAt: Date }) {
  const earlier = await ShiftSession.find({ branchId: shift.branchId, openedAt: { $lt: shift.openedAt } }, { _id: 1, userId: 1 })
    .sort({ openedAt: -1 })
    .limit(10)
    .populate<{ userId: { name: string } }>('userId', 'name');
  const closes = await ShiftStockCount.find({ shiftSessionId: { $in: earlier.map((e) => e._id) }, phase: 'close' });
  const session = earlier.find((e) => closes.some((c) => c.shiftSessionId.equals(e._id)));
  if (!session) return null;
  return { session, count: closes.find((c) => c.shiftSessionId.equals(session._id))! };
}

const net = (m: GroupMovement | undefined) => (m ? m.stockIn - m.saleOut - m.otherOut : 0);

/**
 * Reference numbers shown next to each input while counting:
 *  - before selling: the previous shift's "after" count, and what should be on the shelf now
 *    once anything that moved since (deliveries, sales outside a shift) is applied;
 *  - after selling: this shift's "before" count, and what should be left after this shift's movements.
 * Expected values are computed up to the moment of counting (or now, if not counted yet).
 */
export async function getCountReference(shiftSessionId: string | Types.ObjectId) {
  const shift = await ShiftSession.findById(shiftSessionId, { branchId: 1, openedAt: 1 });
  if (!shift) throw ApiError.notFound('Shift session not found');
  const groups = await getActiveGroups();
  const resolve = buildGroupResolver(groups);
  const counts = await ShiftStockCount.find({ shiftSessionId: shift._id });
  const open = counts.find((c) => c.phase === 'open');
  const close = counts.find((c) => c.phase === 'close');
  const now = new Date();

  const prev = await findPreviousClose(shift);
  const openAt = open?.countedAt ?? now;
  const sincePrev = prev ? await movementByGroup(shift.branchId, prev.count.countedAt, openAt, resolve) : new Map<string, GroupMovement>();
  const sinceOpen = open ? await movementByGroup(shift.branchId, open.countedAt, close?.countedAt ?? now, resolve) : new Map<string, GroupMovement>();
  const prevQty = new Map(prev?.count.lines.map((l) => [l.groupId.toString(), l.countedQty]) ?? []);
  const openQty = new Map(open?.lines.map((l) => [l.groupId.toString(), l.countedQty]) ?? []);

  // What happened to each group this shift, for the note column of the "after" sheet (ขาย 6 · grab 2 · แถม 2 · เติม 6).
  const bills = await loadShiftBills(shift._id);
  const items = bills.flatMap((bill) => bill.lines.map((line) => ({ ...line, bucket: bill.bucket })));
  const itemSkus = await ProductSku.find({ _id: { $in: [...new Set(items.map((i) => i.skuId.toString()))] } }, { productId: 1, power: 1 });
  const itemGroup = new Map(itemSkus.map((x) => [x._id.toString(), resolve(x)?._id.toString()]));
  const activity = new Map<string, { sold: Record<string, number>; giveaway: number }>();
  for (const i of items) {
    const gid = itemGroup.get(i.skuId.toString());
    if (!gid) continue;
    const a = activity.get(gid) ?? { sold: {}, giveaway: 0 };
    if (i.unitPriceAtSale === 0) a.giveaway += i.qty;
    else {
      a.sold[i.bucket] = (a.sold[i.bucket] ?? 0) + i.qty;
    }
    activity.set(gid, a);
  }

  return {
    previous: prev ? { shiftSessionId: prev.session._id, userName: prev.session.userId?.name ?? null, countedAt: prev.count.countedAt } : null,
    lines: groups.map((g) => {
      const gid = g._id.toString();
      const previousAfter = prevQty.get(gid);
      const before = openQty.get(gid);
      return {
        groupId: gid,
        previousAfter: previousAfter ?? null,
        movedSincePrevious: net(sincePrev.get(gid)),
        expectedBefore: previousAfter === undefined ? null : previousAfter + net(sincePrev.get(gid)),
        before: before ?? null,
        movedSinceBefore: net(sinceOpen.get(gid)),
        expectedAfter: before === undefined ? null : before + net(sinceOpen.get(gid)),
        sold: activity.get(gid)?.sold ?? {},
        giveaway: activity.get(gid)?.giveaway ?? 0,
        stockIn: sinceOpen.get(gid)?.stockIn ?? 0,
        otherOut: sinceOpen.get(gid)?.otherOut ?? 0,
      };
    }),
  };
}

/**
 * Shift handover check: this shift's "before" count against the previous
 * shift's "after" count at the same branch, adjusted for anything that moved
 * in between (e.g. a delivery received between shifts). A difference means
 * stock went missing or was miscounted across the handover.
 */
export async function getHandover(shiftSessionId: string | Types.ObjectId) {
  const shift = await ShiftSession.findById(shiftSessionId, { branchId: 1, openedAt: 1 });
  if (!shift) throw ApiError.notFound('Shift session not found');
  const open = await ShiftStockCount.findOne({ shiftSessionId: shift._id, phase: 'open' });
  if (!open) return null;

  const prev = await findPreviousClose(shift);
  if (!prev) return { previous: null, lines: [], mismatchCount: 0 };
  const { session: prevSession, count: prevClose } = prev;

  const groups = await getActiveGroups();
  const movement = await movementByGroup(shift.branchId, prevClose.countedAt, open.countedAt, buildGroupResolver(groups));
  const prevQty = new Map(prevClose.lines.map((l) => [l.groupId.toString(), l.countedQty]));

  const lines = open.lines.map((l) => {
    const gid = l.groupId.toString();
    const previousAfter = prevQty.get(gid);
    const m = movement.get(gid) ?? { saleOut: 0, stockIn: 0, otherOut: 0 };
    const movedBetween = m.stockIn - m.saleOut - m.otherOut;
    const expected = previousAfter === undefined ? null : previousAfter + movedBetween;
    return {
      groupId: gid,
      name: l.groupName,
      previousAfter: previousAfter ?? null,
      movedBetween,
      expected,
      counted: l.countedQty,
      diff: expected === null ? null : l.countedQty - expected,
    };
  });

  return {
    previous: { shiftSessionId: prevSession._id, userName: prevSession.userId?.name ?? null, countedAt: prevClose.countedAt },
    lines,
    mismatchCount: lines.filter((l) => l.diff !== null && l.diff !== 0).length,
  };
}

/**
 * Everything the paper notebook tracks for one shift: sales tallied per
 * group / price / channel, giveaways, the before/after stock sheet with the
 * movements in between, and the cash position.
 */
export async function getShiftSummary(shiftSessionId: string) {
  const shift = await ShiftSession.findById(shiftSessionId)
    .populate<{ userId: { _id: Types.ObjectId; name: string } }>('userId', 'name')
    .populate<{ branchId: { _id: Types.ObjectId; name: string } }>('branchId', 'name')
    .populate<{ shiftDefinitionId: { name: string; startTime: string; endTime: string } | null }>('shiftDefinitionId', 'name startTime endTime');
  if (!shift) throw ApiError.notFound('Shift session not found');

  const groups = await getActiveGroups();
  const resolve = buildGroupResolver(groups);
  const groupOrder = new Map(groups.map((g, i) => [g._id.toString(), i]));

  // --- Sales, tallied like the notebook -----------------------------------------
  // POS bills plus online (chat) orders logged during the shift. Rows are split by
  // bucket — หน้าร้าน / Grab / online — rather than by individual chat channel.
  const bills = await loadShiftBills(shift._id);
  const items = bills.flatMap((b) => b.lines.map((line) => ({ ...line, channel: b.bucket as string })));
  const skus = await ProductSku.find({ _id: { $in: items.map((i) => i.skuId) } }).populate<{ productId: { _id: Types.ObjectId; name: string; type: string } }>(
    'productId',
    'name type',
  );
  const skuMap = new Map(skus.map((s) => [s._id.toString(), s]));

  type Tally = { groupId: string | null; groupName: string; unitLabel: string; isLens: boolean; channel: string; unitPrice: number; qty: number; amount: number };
  const tallies = new Map<string, Tally>();
  const giveaways: { skuCode: string; productName: string; qty: number; reason?: string; channel: string }[] = [];
  const overrides: { skuCode: string; productName: string; qty: number; regularPrice: number; unitPrice: number; reason?: string }[] = [];
  const soldByGroup = new Map<string, number>();
  const oversold: { skuCode: string; productName: string; power?: number; qty: number; channel: string }[] = [];

  for (const item of items) {
    const sku = skuMap.get(item.skuId.toString());
    const product = sku?.productId;
    const group = sku ? resolve({ _id: sku._id, productId: product!._id, power: sku.power }) : null;
    const channel = item.channel;
    const key = `${group?._id ?? 'none'}|${channel}|${item.unitPriceAtSale}`;
    if (!tallies.has(key)) {
      tallies.set(key, {
        groupId: group?._id.toString() ?? null,
        groupName: group?.name ?? product?.name ?? 'ไม่ได้จัดกลุ่ม',
        unitLabel: group?.unitLabel ?? (product?.type === 'contact_lens' ? 'คู่' : 'ชิ้น'),
        isLens: product?.type === 'contact_lens',
        channel,
        unitPrice: item.unitPriceAtSale,
        qty: 0,
        amount: 0,
      });
    }
    const t = tallies.get(key)!;
    t.qty += item.qty;
    t.amount += item.lineTotal;
    if (group) soldByGroup.set(group._id.toString(), (soldByGroup.get(group._id.toString()) ?? 0) + item.qty);

    if (item.oversoldQty) {
      oversold.push({ skuCode: sku?.skuCode ?? '-', productName: product?.name ?? '-', power: sku?.power, qty: item.oversoldQty, channel });
    }
    if (item.priceOverrideReason !== undefined) {
      const row = { skuCode: sku?.skuCode ?? '-', productName: product?.name ?? '-', qty: item.qty, reason: item.priceOverrideReason };
      if (item.unitPriceAtSale === 0) giveaways.push({ ...row, channel });
      else overrides.push({ ...row, regularPrice: item.unitPriceAtSale + item.discountApplied / item.qty, unitPrice: item.unitPriceAtSale });
    }
  }

  const salesLines = [...tallies.values()].sort(
    (a, b) =>
      Number(b.isLens) - Number(a.isLens) ||
      (a.groupId ? (groupOrder.get(a.groupId) ?? 999) : 999) - (b.groupId ? (groupOrder.get(b.groupId) ?? 999) : 999) ||
      (a.channel === 'store' ? 0 : 1) - (b.channel === 'store' ? 0 : 1) ||
      a.channel.localeCompare(b.channel) ||
      b.unitPrice - a.unitPrice,
  );

  const byPayment: Record<string, number> = { cash: 0, transfer: 0, qr: 0, platform: 0 };
  for (const p of bills.flatMap((b) => b.payments)) byPayment[p.method] = (byPayment[p.method] ?? 0) + p.amount;
  const byChannel: Record<string, number> = {};
  for (const b of bills) byChannel[b.channel] = (byChannel[b.channel] ?? 0) + b.netTotal;
  const { byBucket } = sumByBucket(bills);

  const refunds = await Refund.find({ shiftSessionId: shift._id, status: 'approved' });
  const refundTotal = refunds.reduce((sum, r) => sum + r.totalRefundAmount, 0);

  const lens = salesLines.filter((l) => l.isLens);
  const other = salesLines.filter((l) => !l.isLens);
  const grossTotal = bills.reduce((s, x) => s + x.netTotal, 0);
  const totals = {
    saleCount: bills.length,
    onlineOrderCount: bills.filter((b) => b.source === 'online_order').length,
    lensQty: lens.reduce((s, l) => s + l.qty, 0),
    lensAmount: lens.reduce((s, l) => s + l.amount, 0),
    otherQty: other.reduce((s, l) => s + l.qty, 0),
    otherAmount: other.reduce((s, l) => s + l.amount, 0),
    // Line totals are before cart-level discounts (coupon / cart promotion); this is what was actually charged.
    cartDiscount: salesLines.reduce((s, l) => s + l.amount, 0) - grossTotal,
    grossTotal,
    refundTotal,
    netTotal: grossTotal - refundTotal,
    byChannel,
    byBucket,
    byPayment,
  };

  // --- Stock sheet: before → movements → after ----------------------------------
  const counts = await ShiftStockCount.find({ shiftSessionId: shift._id }).populate<{ countedBy: { name: string } }>('countedBy', 'name');
  const openCount = counts.find((c) => c.phase === 'open') ?? null;
  const closeCount = counts.find((c) => c.phase === 'close') ?? null;
  const openQty = new Map(openCount?.lines.map((l) => [l.groupId.toString(), l.countedQty]) ?? []);
  const closeQty = new Map(closeCount?.lines.map((l) => [l.groupId.toString(), l.countedQty]) ?? []);

  // Movements between the two counts decide what the "after" count should be.
  const windowStart = openCount?.countedAt ?? shift.openedAt;
  const windowEnd = closeCount?.countedAt ?? shift.closedAt ?? new Date();
  const movement = await movementByGroup(shift.branchId._id, windowStart, windowEnd, resolve);

  const systemNow = await getSystemQtyByGroup(shift.branchId._id, groups);
  const stock = groups.map((g) => {
    const gid = g._id.toString();
    const m = movement.get(gid) ?? { saleOut: 0, stockIn: 0, otherOut: 0 };
    const before = openQty.get(gid);
    const after = closeQty.get(gid);
    const expectedAfter = before === undefined ? undefined : before - m.saleOut + m.stockIn - m.otherOut;
    return {
      groupId: gid,
      name: g.name,
      unitLabel: g.unitLabel,
      before: before ?? null,
      sold: soldByGroup.get(gid) ?? 0,
      saleOut: m.saleOut,
      stockIn: m.stockIn,
      otherOut: m.otherOut,
      expectedAfter: expectedAfter ?? null,
      after: after ?? null,
      variance: after !== undefined && expectedAfter !== undefined ? after - expectedAfter : null,
      systemNow: systemNow.get(gid) ?? 0,
    };
  });

  const cash = await computeShiftExpectedTotals(shift._id.toString());

  return {
    shift: {
      _id: shift._id,
      status: shift.status,
      branch: shift.branchId,
      user: shift.userId,
      shiftDefinition: shift.shiftDefinitionId,
      openedAt: shift.openedAt,
      closedAt: shift.closedAt ?? null,
      openingFloat: shift.openingFloat,
      closingCashCounted: shift.closingCashCounted ?? null,
      closingTransferCounted: shift.closingTransferCounted ?? null,
      cashVariance: shift.cashVariance ?? null,
      varianceReason: shift.varianceReason ?? null,
      carryForwardFloat: shift.carryForwardFloat ?? null,
      cashHandedIn: shift.cashHandedIn ?? null,
    },
    salesLines,
    giveaways,
    oversold,
    overrides,
    totals,
    stock,
    handover: await getHandover(shift._id),
    stockCounts: {
      open: openCount ? { countedAt: openCount.countedAt, countedBy: openCount.countedBy?.name ?? null, note: openCount.note ?? null } : null,
      close: closeCount ? { countedAt: closeCount.countedAt, countedBy: closeCount.countedBy?.name ?? null, note: closeCount.note ?? null } : null,
    },
    cash,
  };
}
