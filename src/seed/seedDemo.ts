/* eslint-disable no-console */
/**
 * Adds ~30 days of realistic demo activity ON TOP OF the existing database
 * (never wipes anything): purchases, shifts per schedule, store sales,
 * cash movements, refunds, online orders, transfers, stock adjustments and
 * expenses — so every report and screen has data to look at.
 *
 * Every operation runs through the real services (stock, ledger, payments,
 * audit and notifications stay consistent), timed inside a window. At the end
 * every Date written inside a window is shifted to that operation's simulated
 * time, so the data spreads over the past 30 days.
 *
 * Markers for finding demo data later: Sale/Order idempotencyKey `demo-*`,
 * Purchase invoiceNo `DEMO-*`, customers with email `*@demo.shikkulens.local`,
 * reasons/descriptions prefixed `[DEMO]`.
 *
 *   npm run seed:demo            # refuses if demo data already exists
 *   npm run seed:demo -- --days 14
 */
import mongoose, { Types, mongo } from 'mongoose';
import { connectDb, disconnectDb, withTransaction } from '../config/db';

import { Branch, IBranch } from '../models/Branch';
import { User, IUser } from '../models/User';
import { Product } from '../models/Product';
import { ProductSku, IProductSku } from '../models/ProductSku';
import { Supplier } from '../models/Supplier';
import { MemberLevel } from '../models/MemberLevel';
import { Customer, ICustomer } from '../models/Customer';
import { Promotion } from '../models/Promotion';
import { ShiftDefinition, IShiftDefinition } from '../models/ShiftDefinition';
import { ShiftSchedule } from '../models/ShiftSchedule';
import { ShiftSession } from '../models/ShiftSession';
import { Sale, ISale } from '../models/Sale';
import { SaleItem } from '../models/SaleItem';
import { Payment } from '../models/Payment';
import { Expense } from '../models/Expense';
import { DailySales } from '../models/DailySales';
import { StockTransferItem } from '../models/StockTransferItem';
import { Setting, SETTING_KEYS } from '../models/Setting';

import * as purchaseService from '../services/purchaseService';
import * as saleService from '../services/saleService';
import * as shiftService from '../services/shiftService';
import * as cashMovementService from '../services/cashMovementService';
import * as transferService from '../services/transferService';
import * as refundService from '../services/refundService';
import * as orderService from '../services/orderService';
import { evaluateCart } from '../services/promotionService';
import { moveStock } from '../services/inventoryService';
import { PaymentMethod } from '../config/constants';

const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;

// ---------------------------------------------------------------------------
// Deterministic randomness so reruns on a fresh DB look the same.
let rngState = 20260929;
function rand() {
  rngState = (rngState * 1664525 + 1013904223) % 4294967296;
  return rngState / 4294967296;
}
const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const chance = (p: number) => rand() < p;
const baht = (n: number) => Math.round(n * 100);

// ---------------------------------------------------------------------------
// Time windows: each operation runs "now", then gets shifted to its target time.
const scriptStart = Date.now();
const windows: { t0: number; t1: number; delta: number }[] = [];
let lastT1 = 0;

async function at<T>(target: Date, fn: () => Promise<T>): Promise<T> {
  while (Date.now() <= lastT1) await new Promise((r) => setTimeout(r, 1));
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const t1 = Date.now();
    windows.push({ t0, t1, delta: target.getTime() - t0 });
    lastT1 = t1;
  }
}

function findWindow(ms: number) {
  let lo = 0;
  let hi = windows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = windows[mid];
    if (ms < w.t0) hi = mid - 1;
    else if (ms > w.t1) lo = mid + 1;
    else return w;
  }
  return null;
}

/** Recursively shifts every Date that was written inside a window. Returns true if anything changed. */
function rebaseValue(value: unknown): { value: unknown; changed: boolean } {
  if (value instanceof Date) {
    const w = findWindow(value.getTime());
    return w ? { value: new Date(value.getTime() + w.delta), changed: true } : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = rebaseValue(v);
      changed ||= r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === 'object' && !(value instanceof Types.ObjectId) && value.constructor === Object) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = rebaseValue(v);
      changed ||= r.changed;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

async function rebaseAllTimestamps() {
  const db = mongoose.connection.db!;
  const since = new Date(scriptStart);
  const collections = (await db.listCollections().toArray()).map((c) => c.name);
  for (const name of collections) {
    const coll = db.collection(name);
    const cursor = coll.find({
      $or: [{ createdAt: { $gte: since } }, { updatedAt: { $gte: since } }],
    });
    let ops: mongo.AnyBulkWriteOperation[] = [];
    let count = 0;
    for await (const doc of cursor) {
      const { value, changed } = rebaseValue(doc);
      if (!changed) continue;
      ops.push({
        replaceOne: {
          filter: { _id: doc._id },
          replacement: value as Record<string, unknown>,
        },
      });
      count += 1;
      if (ops.length >= 500) {
        await coll.bulkWrite(ops, { ordered: false });
        ops = [];
      }
    }
    if (ops.length) await coll.bulkWrite(ops, { ordered: false });
    if (count) console.log(`  rebased ${count} ${name}`);
  }
}

// ---------------------------------------------------------------------------
function dayAt(daysAgo: number, hhmm: string, jitterMin = 0) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return new Date(d.getTime() + jitterMin * MIN);
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

type Stock = Map<string, number>; // skuId -> qty, per branch

interface BranchCtx {
  branch: IBranch;
  defs: IShiftDefinition[];
  staff: [IUser, IUser]; // morning, afternoon
  manager: IUser;
  stock: Stock;
  salesPerShift: [number, number];
  recentSales: { sale: ISale; at: Date }[];
}

const counters = {
  sales: 0,
  orders: 0,
  refunds: 0,
  shifts: 0,
  cashMovements: 0,
  transfers: 0,
  expenses: 0,
  skipped: 0,
};

async function main() {
  const daysArg = process.argv.indexOf('--days');
  const DAYS = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 30;

  await connectDb();

  if (await Sale.exists({ idempotencyKey: /^demo-/ })) {
    console.error('Demo data already exists (Sale idempotencyKey demo-*). Aborting so nothing is doubled.');
    await disconnectDb();
    process.exit(1);
  }
  if (await ShiftSession.exists({ status: 'open' })) {
    console.error('There is an open shift right now — close it first, the demo needs to open shifts itself.');
    await disconnectDb();
    process.exit(1);
  }

  // --- Existing master data -------------------------------------------------
  const branches = await Branch.find().sort({ createdAt: 1 });
  if (branches.length === 0) throw new Error('No branches — run the base seed first');
  const admin = await User.findOne({ role: 'admin' });
  if (!admin) throw new Error('No admin user');

  const ctxs: BranchCtx[] = [];
  for (const [i, branch] of branches.entries()) {
    const defs = await ShiftDefinition.find({
      branchId: branch._id,
      active: true,
    }).sort({ startTime: 1 });
    if (defs.length === 0) {
      console.warn(`Branch ${branch.name} has no shift definitions — skipping`);
      continue;
    }
    const staff = await User.find({
      role: 'staff',
      branchIds: branch._id,
      active: { $ne: false },
    });
    const manager = (await User.findOne({ role: 'branch_manager', branchIds: branch._id })) ?? admin;
    const morning = staff[0] ?? manager;
    const afternoon = staff[1] ?? manager;
    ctxs.push({
      branch,
      defs,
      staff: [morning, afternoon],
      manager,
      stock: new Map(),
      salesPerShift: i === 0 ? [5, 10] : [3, 6],
      recentSales: [],
    });
  }

  // Sellable SKUs: a spread across the real catalog.
  const products = await Product.find({
    defaultPriceRegular: { $gt: 0 },
    active: { $ne: false },
  });
  const chosenSkus: IProductSku[] = [];
  for (const p of products.sort(() => rand() - 0.5).slice(0, 30)) {
    const skus = await ProductSku.find({
      productId: p._id,
      active: true,
      priceRegular: { $gt: 0 },
    }).limit(40);
    chosenSkus.push(...skus.sort(() => rand() - 0.5).slice(0, 2));
  }
  if (chosenSkus.length === 0) throw new Error('No sellable SKUs with a price');
  const skuById = new Map(chosenSkus.map((s) => [s._id.toString(), s]));
  // A handful of "best sellers" get picked more often.
  const hotSkus = chosenSkus.slice(0, 8);
  console.log(`Using ${chosenSkus.length} SKUs from ${products.length} products, ${ctxs.length} branches, ${DAYS} days`);

  const demoSessions: {
    id: Types.ObjectId;
    branchId: string;
    openedAt: Date;
  }[] = [];
  try {
    // --- Master data additions (35 days ago) ------------------------------------
    const setupAt = dayAt(DAYS + 5, '10:00');
    const { supplier, supplier2, customers } = await at(setupAt, async () => {
      const supplier =
        (await Supplier.findOne()) ??
        (await Supplier.create({
          name: 'บริษัท คอนแทคเลนส์ ซัพพลาย จำกัด',
          phone: '021234567',
        }));
      const supplier2 = await Supplier.create({
        name: '[DEMO] บริษัท เลนส์สวย เทรดดิ้ง',
        phone: '029998888',
        taxId: '0105561234567',
      });

      const gold = (await MemberLevel.findOne({ name: 'Gold' })) ?? (await MemberLevel.create({ name: 'Gold', thresholdSpend: 500000 }));
      const silver =
        (await MemberLevel.findOne({ name: 'Silver' })) ??
        (await MemberLevel.create({
          name: 'Silver',
          thresholdSpend: 200000,
          benefitsDescription: 'ราคาสมาชิก',
        }));

      const names = [
        'ณัฐธิดา ใจดี',
        'พิมพ์ชนก ศรีสุข',
        'กมลชนก แก้วมณี',
        'ปวีณา ทองดี',
        'ชลธิชา บุญมา',
        'สุภาวดี รักษ์ไทย',
        'ธนพร วงศ์สวัสดิ์',
        'อรอุมา มีสุข',
        'ศิริพร จันทร์เพ็ญ',
        'วรรณภา สายทอง',
        'นภัสสร พรหมมา',
        'จิราพร แสงทอง',
        'กัญญาณัฐ ทองคำ',
        'ภัทรา สมบูรณ์',
        'ปิยะนุช ใจงาม',
        'รัตนา ศรีวงศ์',
        'ขวัญใจ บุญญา',
        'มณีรัตน์ ดวงดี',
      ];
      const customers: ICustomer[] = [];
      for (const [i, name] of names.entries()) {
        customers.push(
          await Customer.create({
            name,
            phone: `08${String(10000000 + i * 7919).padStart(8, '0')}`,
            email: `customer${i + 1}@demo.shikkulens.local`,
            memberLevelId: i % 5 === 0 ? gold._id : i % 3 === 0 ? silver._id : undefined,
            birthday: new Date(1990 + (i % 12), i % 12, 1 + (i % 27)),
          }),
        );
      }

      await Promotion.create({
        name: '[DEMO] ลด 15% สินค้าขายดี',
        type: 'percent',
        scopeSkuIds: hotSkus.slice(0, 3).map((s) => s._id),
        startAt: dayAt(DAYS + 5, '00:00'),
        endAt: dayAt(-30, '23:59'),
        stackable: false,
        config: { percentOff: 15 },
      });

      // Make sure refunds of opened boxes are possible to demo "rejected" vs "approved" paths.
      if (!(await Setting.exists({ key: SETTING_KEYS.refundPolicy }))) {
        await Setting.create({
          key: SETTING_KEYS.refundPolicy,
          value: { returnWindowDays: 7, allowOpenedReturn: false },
        });
      }
      return { supplier, supplier2, customers };
    });

    // --- Schedules: past DAYS + next 14 days, published ------------------------
    await at(setupAt, async () => {
      for (const c of ctxs) {
        for (let d = DAYS; d >= -14; d--) {
          const date = startOfDay(dayAt(d, '00:00'));
          for (const [i, def] of c.defs.slice(0, 2).entries()) {
            await ShiftSchedule.findOneAndUpdate(
              {
                branchId: c.branch._id,
                userId: c.staff[i]._id,
                shiftDefinitionId: def._id,
                date,
              },
              {
                $setOnInsert: {
                  status: d >= -7 ? 'published' : 'draft',
                  publishedAt: d >= -7 ? new Date() : undefined,
                },
              },
              { upsert: true },
            );
          }
        }
      }
    });

    // --- Opening stock: purchase for every branch ------------------------------
    for (const [bi, c] of ctxs.entries()) {
      const purchaseAt = dayAt(DAYS + 2, '11:00');
      await at(purchaseAt, async () => {
        const items = chosenSkus.map((sku, i) => {
          const nearExpiry = i % 9 === 0;
          return {
            skuId: sku._id.toString(),
            qty: bi === 0 ? randInt(25, 45) : randInt(12, 25),
            unitCost: Math.round((sku.priceRegular * randInt(38, 55)) / 100),
            lot: `LOT-${String(i + 1).padStart(3, '0')}`,
            expiryDate: new Date(Date.now() + (nearExpiry ? randInt(15, 80) : randInt(300, 720)) * DAY).toISOString(),
          };
        });
        const { purchase } = await purchaseService.createPurchase({
          supplierId: supplier._id.toString(),
          branchId: c.branch._id.toString(),
          invoiceNo: `DEMO-${c.branch.code}-0001`,
          purchaseDate: purchaseAt.toISOString(),
          shippingCost: baht(350),
          discountTotal: baht(500),
          items,
          createdBy: admin._id.toString(),
        });
        await purchaseService.confirmPurchase(purchase._id.toString(), admin._id.toString());
        for (const it of items) c.stock.set(it.skuId, (c.stock.get(it.skuId) ?? 0) + it.qty);
      });
    }

    // --- Day-by-day simulation ---------------------------------------------------
    const now = Date.now();
    const onlineCtx = ctxs.find((c) => c.branch.isDefaultOnlineBranch) ?? ctxs[0];

    function pickLines(c: BranchCtx) {
      const lines: { sku: IProductSku; qty: number }[] = [];
      const n = chance(0.6) ? 1 : chance(0.7) ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const sku = chance(0.45) ? pick(hotSkus) : pick(chosenSkus);
        if (lines.some((l) => l.sku._id.equals(sku._id))) continue;
        const qty = chance(0.55) ? 2 : 1;
        if ((c.stock.get(sku._id.toString()) ?? 0) < qty) continue;
        lines.push({ sku, qty });
      }
      return lines;
    }

    function splitPayments(total: number): { method: PaymentMethod; amount: number; referenceNo?: string }[] {
      const r = rand();
      if (r < 0.06 && total > 200) {
        const cash = Math.round(total / 2 / 100) * 100;
        return [
          { method: 'cash', amount: cash },
          {
            method: 'transfer',
            amount: total - cash,
            referenceNo: `TRF${randInt(100000, 999999)}`,
          },
        ];
      }
      if (r < 0.5) return [{ method: 'cash', amount: total }];
      if (r < 0.78)
        return [
          {
            method: 'transfer',
            amount: total,
            referenceNo: `TRF${randInt(100000, 999999)}`,
          },
        ];
      return [
        {
          method: 'qr',
          amount: total,
          referenceNo: `QR${randInt(100000, 999999)}`,
        },
      ];
    }

    async function runShift(c: BranchCtx, daysAgo: number, shiftIdx: number, opts: { weekendBoost: number; leaveOpen: boolean; isLast: boolean }) {
      const def = c.defs[shiftIdx] ?? c.defs[0];
      const user = c.staff[shiftIdx] ?? c.staff[0];
      // First shift may open a little early; later shifts open just after the previous one closed.
      const openAt = dayAt(daysAgo, def.startTime, shiftIdx === 0 ? randInt(-10, 5) : randInt(1, 10));
      if (openAt.getTime() > now - 20 * MIN) return;
      const plannedClose = dayAt(daysAgo, def.endTime, opts.isLast ? randInt(0, 20) : -randInt(0, 8));
      const closeAt = new Date(Math.min(plannedClose.getTime(), now - 3 * MIN));
      const unscheduled = daysAgo === 17 && shiftIdx === 1; // one shift opened outside the schedule

      // Open
      const shift = await at(openAt, async () => {
        const lastClosed = await ShiftSession.findOne({
          branchId: c.branch._id,
          status: 'approved',
        }).sort({ closedAt: -1 });
        const standard = 200000;
        const expected = lastClosed?.carryForwardFloat ?? standard;
        const odd = chance(0.05);
        const s = await shiftService.openShift({
          branchId: c.branch._id.toString(),
          userId: user._id.toString(),
          openingFloat: odd ? expected - baht(100) : expected,
          openingFloatVarianceReason: odd ? '[DEMO] เงินทอนขาดจากกะก่อน' : undefined,
          approverId: c.manager._id.toString(),
        });
        if (!unscheduled) {
          const schedule = await ShiftSchedule.findOne({
            branchId: c.branch._id,
            userId: user._id,
            shiftDefinitionId: def._id,
            date: startOfDay(openAt),
          });
          await ShiftSession.updateOne(
            { _id: s._id },
            {
              $set: {
                shiftDefinitionId: def._id,
                scheduleId: schedule?._id,
                openedOutsideSchedule: false,
              },
              $unset: { openApprovedBy: 1 },
            },
          );
        }
        return s;
      });
      counters.shifts += 1;
      demoSessions.push({
        id: shift._id,
        branchId: c.branch._id.toString(),
        openedAt: openAt,
      });

      // Sales
      const endForSales = opts.leaveOpen ? Math.min(closeAt.getTime(), now - 2 * MIN) : closeAt.getTime() - 5 * MIN;
      const span = endForSales - openAt.getTime() - 10 * MIN;
      const saleCount = span <= 0 ? 0 : Math.round(randInt(...c.salesPerShift) * opts.weekendBoost * Math.min(1, span / (6 * HOUR)));
      const times = Array.from({ length: saleCount }, () => openAt.getTime() + 10 * MIN + rand() * span).sort((a, b) => a - b);

      for (const t of times) {
        const lines = pickLines(c);
        if (lines.length === 0) continue;
        const customer = chance(0.4) ? pick(customers) : undefined;
        const useCoupon = chance(0.03);
        try {
          const sale = await at(new Date(t), async () => {
            const quoteParams = {
              branchId: c.branch._id.toString(),
              channel: 'store' as const,
              customerId: customer?._id.toString(),
              lines,
            };
            let couponCode: string | undefined = useCoupon ? 'WELCOME50' : undefined;
            let quote = await evaluateCart({
              ...quoteParams,
              couponCode,
            }).catch(() => null);
            if (!quote) {
              couponCode = undefined;
              quote = await evaluateCart(quoteParams);
            }
            return saleService.createSale({
              branchId: c.branch._id.toString(),
              shiftSessionId: shift._id.toString(),
              customerId: customer?._id.toString(),
              items: lines.map((l) => ({
                skuId: l.sku._id.toString(),
                qty: l.qty,
              })),
              payments: splitPayments(quote.netTotal),
              couponCode,
              idempotencyKey: `demo-sale-${c.branch.code}-${daysAgo}-${shiftIdx}-${counters.sales}`,
              soldBy: user._id.toString(),
            });
          });
          for (const l of lines) c.stock.set(l.sku._id.toString(), (c.stock.get(l.sku._id.toString()) ?? 0) - l.qty);
          c.recentSales.push({ sale, at: new Date(t) });
          counters.sales += 1;
        } catch (err) {
          counters.skipped += 1;
          console.warn(`  sale skipped: ${(err as Error).message}`);
        }
      }

      // Cash movements
      const midShift = new Date(openAt.getTime() + Math.max(span, 30 * MIN) / 2);
      if (chance(0.22)) {
        await at(midShift, () =>
          cashMovementService.createCashMovement({
            shiftSessionId: shift._id.toString(),
            type: 'cash_out',
            amount: baht(pick([45, 80, 120, 150, 250, 320])),
            reason: `[DEMO] ${pick(['ซื้อน้ำดื่ม', 'ซื้อถุงใส่สินค้า', 'ค่าส่งเอกสาร', 'ซื้อกระดาษใบเสร็จ', 'ค่าวินมอเตอร์ไซค์'])}`,
            performedBy: user._id.toString(),
            createExpenseCategory: 'other',
          }),
        );
        counters.cashMovements += 1;
      }
      if (chance(0.1)) {
        await at(new Date(midShift.getTime() + 20 * MIN), () =>
          cashMovementService.createCashMovement({
            shiftSessionId: shift._id.toString(),
            type: 'cash_in',
            amount: baht(pick([500, 1000])),
            reason: '[DEMO] แลกเงินทอนเพิ่ม',
            performedBy: user._id.toString(),
          }),
        );
        counters.cashMovements += 1;
      }

      // Store refund of a sale from the last few days (must happen while this shift is open)
      if (!opts.leaveOpen || span > HOUR) {
        await maybeRefund(c, shift._id, daysAgo, new Date(Math.min(endForSales, midShift.getTime() + HOUR)), user);
      }

      if (opts.leaveOpen) return;

      // Deposit before closing on busy evenings
      if (shiftIdx === 1 && chance(0.25)) {
        const totals = await shiftService.computeShiftExpectedTotals(shift._id.toString());
        const depositable = totals.systemCashExpected - 200000;
        if (depositable > baht(2000)) {
          await at(new Date(closeAt.getTime() - 3 * MIN), () =>
            cashMovementService.createCashMovement({
              shiftSessionId: shift._id.toString(),
              type: 'deposit',
              amount: Math.floor(depositable / 100000) * 100000,
              reason: '[DEMO] นำเงินฝากธนาคาร',
              performedBy: user._id.toString(),
            }),
          );
          counters.cashMovements += 1;
        }
      }

      // Close
      await at(closeAt, async () => {
        const totals = await shiftService.computeShiftExpectedTotals(shift._id.toString());
        const variance = chance(0.15) ? pick([-1, 1]) * baht(pick([20, 50, 100, 120, 300, 500])) : 0;
        const counted = Math.max(0, totals.systemCashExpected + variance);
        const carry = Math.min(200000, counted);
        await shiftService.closeShift({
          shiftSessionId: shift._id.toString(),
          userId: user._id.toString(),
          closingCashCounted: counted,
          closingTransferCounted: totals.systemTransferExpected,
          varianceReason:
            counted !== totals.systemCashExpected
              ? `[DEMO] ${counted < totals.systemCashExpected ? pick(['ทอนเงินผิด', 'นับเงินพลาด หาไม่เจอ']) : pick(['ลูกค้าไม่รับเงินทอน', 'ลืมบันทึกเงินเข้า'])}`
              : undefined,
          carryForwardFloat: carry,
          cashHandedIn: counted - carry,
        });
      });

      // Approve (leave yesterday's last shift of the second branch waiting for review)
      const keepPending = daysAgo === 1 && shiftIdx === 1 && c !== ctxs[0];
      if (keepPending) return;
      const approveAt = new Date(Math.min(closeAt.getTime() + randInt(15, 90) * MIN, now - MIN));
      await at(approveAt, () => shiftService.approveShiftClose(shift._id.toString(), c.manager._id.toString()));

      // One approved shift gets reopened by admin to show the correction flow
      if (daysAgo === 10 && shiftIdx === 0 && c === ctxs[0]) {
        await at(new Date(approveAt.getTime() + 2 * HOUR), () =>
          shiftService.reopenShift(shift._id.toString(), admin!._id.toString(), '[DEMO] ตรวจสอบยอดโอนซ้ำ'),
        );
      }
    }

    async function maybeRefund(c: BranchCtx, _shiftId: Types.ObjectId, daysAgo: number, when: Date, user: IUser) {
      if (!chance(0.14)) return;
      const candidates = c.recentSales.filter((s) => {
        const age = (when.getTime() - s.at.getTime()) / DAY;
        return age > 0.02 && age < 5;
      });
      if (candidates.length === 0) return;
      const { sale } = pick(candidates);
      const payments = await Payment.find({
        parentType: 'Sale',
        parentId: sale._id,
      });
      if (payments.length !== 1) return; // keep refund channel simple: single-method bills only
      const items = await SaleItem.find({ saleId: sale._id });
      const item = items.find((i) => i.qty - i.refundedQty > 0);
      if (!item) return;

      const scenario = rand();
      const condition = scenario < 0.55 ? 'sealed' : scenario < 0.85 ? 'defective' : 'wrong_item';
      try {
        const refund = await at(when, () =>
          refundService.createRefundRequest({
            originalType: 'Sale',
            originalId: sale._id.toString(),
            type: 'refund',
            items: [{ originalItemId: item._id.toString(), qty: 1, condition }],
            reason: `[DEMO] ${condition === 'sealed' ? 'ลูกค้าเปลี่ยนใจ ยังไม่แกะกล่อง' : condition === 'defective' ? 'เลนส์ฉีกขาดตั้งแต่แกะ' : 'หยิบค่าสายตาผิด'}`,
            requestedBy: user._id.toString(),
          }),
        );
        counters.refunds += 1;
        if (daysAgo === 0) return; // today's request stays pending for the manager
        const decideAt = new Date(when.getTime() + randInt(10, 40) * MIN);
        if (chance(0.15)) {
          await at(decideAt, () => refundService.rejectRefund(refund._id.toString(), c.manager._id.toString(), '[DEMO] เกินเงื่อนไขการคืนสินค้า'));
        } else {
          await at(decideAt, () =>
            refundService.approveRefund(refund._id.toString(), c.manager._id.toString(), [
              {
                method: payments[0].method,
                amount: refund.totalRefundAmount,
              },
            ]),
          );
          if (condition === 'sealed') c.stock.set(item.skuId.toString(), (c.stock.get(item.skuId.toString()) ?? 0) + 1);
        }
      } catch (err) {
        console.warn(`  refund skipped: ${(err as Error).message}`);
      }
    }

    async function runOnlineOrders(daysAgo: number) {
      const c = onlineCtx;
      const n = randInt(0, 3);
      for (let i = 0; i < n; i++) {
        const placedAt = dayAt(daysAgo, '10:00', randInt(0, 12 * 60));
        if (placedAt.getTime() > now - 5 * MIN) continue;
        const lines = pickLines(c);
        if (lines.length === 0) continue;
        const customer = pick(customers);
        const channel = pick(['line', 'line', 'facebook', 'ig'] as const);
        try {
          const order = await at(placedAt, async () => {
            const quote = await evaluateCart({
              branchId: c.branch._id.toString(),
              channel,
              customerId: customer._id.toString(),
              lines,
            });
            const paid = chance(0.9);
            return orderService.createOrder({
              branchId: c.branch._id.toString(),
              customerId: customer._id.toString(),
              channel,
              items: lines.map((l) => ({
                skuId: l.sku._id.toString(),
                qty: l.qty,
              })),
              shippingMethod: pick(['Kerry Express', 'Flash Express', 'ไปรษณีย์ไทย EMS', 'Grab Express']),
              shippingAddress: `[DEMO] ${randInt(1, 999)}/${randInt(1, 99)} ถนน${pick(['สุขุมวิท', 'พหลโยธิน', 'รัชดาภิเษก', 'ลาดพร้าว'])} กรุงเทพฯ`,
              idempotencyKey: `demo-order-${daysAgo}-${counters.orders}`,
              createdBy: admin!._id.toString(),
              payments: paid
                ? [
                    {
                      method: 'transfer',
                      amount: quote.netTotal,
                      referenceNo: `ONL${randInt(100000, 999999)}`,
                    },
                  ]
                : undefined,
            });
          });
          for (const l of lines) c.stock.set(l.sku._id.toString(), (c.stock.get(l.sku._id.toString()) ?? 0) - l.qty);
          counters.orders += 1;

          // Walk the order through its lifecycle depending on its age
          const steps: ('confirmed' | 'packed' | 'shipped' | 'delivered' | 'cancelled')[] = chance(0.06)
            ? ['cancelled']
            : daysAgo >= 4
              ? ['confirmed', 'packed', 'shipped', 'delivered']
              : daysAgo >= 2
                ? ['confirmed', 'packed', 'shipped']
                : daysAgo === 1
                  ? ['confirmed', 'packed']
                  : chance(0.5)
                    ? ['confirmed']
                    : [];
          let t = placedAt.getTime();
          for (const step of steps) {
            t += (step === 'delivered' ? randInt(20, 40) : randInt(1, 8)) * HOUR;
            const stepAt = new Date(Math.min(t, now - MIN));
            await at(stepAt, () =>
              orderService.updateOrderStatus(order._id.toString(), step, admin!._id.toString(), step === 'cancelled' ? '[DEMO] ลูกค้ายกเลิก' : undefined),
            );
            if (step === 'cancelled') for (const l of lines) c.stock.set(l.sku._id.toString(), (c.stock.get(l.sku._id.toString()) ?? 0) + l.qty);
          }

          // An occasional delivered order comes back (online refunds are transfer-only)
          if (steps.at(-1) === 'delivered' && chance(0.08)) {
            const { OrderItem } = await import('../models/OrderItem');
            const item = await OrderItem.findOne({ orderId: order._id });
            if (item) {
              const refundAt = new Date(Math.min(t + 2 * DAY, now - MIN));
              const refund = await at(refundAt, () =>
                refundService.createRefundRequest({
                  originalType: 'Order',
                  originalId: order._id.toString(),
                  type: 'refund',
                  items: [
                    {
                      originalItemId: item._id.toString(),
                      qty: 1,
                      condition: 'defective',
                    },
                  ],
                  reason: '[DEMO] ลูกค้าแจ้งเลนส์ชำรุดหลังได้รับของ',
                  requestedBy: admin!._id.toString(),
                }),
              );
              await at(new Date(refundAt.getTime() + HOUR), () =>
                refundService.approveRefund(refund._id.toString(), admin!._id.toString(), [{ method: 'transfer', amount: refund.totalRefundAmount }]),
              );
              counters.refunds += 1;
            }
          }
        } catch (err) {
          counters.skipped += 1;
          console.warn(`  order skipped: ${(err as Error).message}`);
        }
      }
    }

    async function stockTransfer(
      daysAgo: number,
      from: BranchCtx,
      to: BranchCtx,
      finalState: 'received' | 'discrepancy' | 'in_transit' | 'sent' | 'cancelled',
    ) {
      const items = chosenSkus
        .filter((s) => (from.stock.get(s._id.toString()) ?? 0) >= 8)
        .slice(0, randInt(2, 4))
        .map((s) => ({ skuId: s._id.toString(), qty: randInt(2, 5) }));
      if (items.length === 0) return;
      const sentAt = dayAt(daysAgo, '11:30');
      const transfer = await at(sentAt, () =>
        transferService.createTransfer({
          fromBranchId: from.branch._id.toString(),
          toBranchId: to.branch._id.toString(),
          items,
          sentBy: from.manager._id.toString(),
        }),
      );
      for (const it of items) from.stock.set(it.skuId, (from.stock.get(it.skuId) ?? 0) - it.qty);
      counters.transfers += 1;
      if (finalState === 'sent') return;
      if (finalState === 'cancelled') {
        await at(new Date(sentAt.getTime() + 2 * HOUR), () =>
          transferService.cancelTransfer(transfer._id.toString(), admin!._id.toString(), '[DEMO] ส่งผิดสาขา'),
        );
        for (const it of items) from.stock.set(it.skuId, (from.stock.get(it.skuId) ?? 0) + it.qty);
        return;
      }
      await at(new Date(sentAt.getTime() + HOUR), () => transferService.markInTransit(transfer._id.toString(), 'Grab Express', from.manager._id.toString()));
      if (finalState === 'in_transit') return;
      const transferItems = await StockTransferItem.find({
        transferId: transfer._id,
      });
      await at(new Date(sentAt.getTime() + 5 * HOUR), () =>
        transferService.receiveTransfer(transfer._id.toString(), {
          items: transferItems.map((ti, i) => ({
            itemId: ti._id.toString(),
            qtyReceived: finalState === 'discrepancy' && i === 0 ? ti.qtySent - 1 : ti.qtySent,
            discrepancyReason: finalState === 'discrepancy' && i === 0 ? '[DEMO] กล่องเสียหายระหว่างขนส่ง 1 กล่อง' : undefined,
          })),
          userId: to.manager._id.toString(),
        }),
      );
      for (const ti of transferItems) {
        const got = finalState === 'discrepancy' && ti === transferItems[0] ? ti.qtySent - 1 : ti.qtySent;
        to.stock.set(ti.skuId.toString(), (to.stock.get(ti.skuId.toString()) ?? 0) + got);
      }
    }

    async function stockMove(
      daysAgo: number,
      c: BranchCtx,
      type: 'adjustment_decrease' | 'adjustment_increase' | 'damage_out' | 'internal_use_out',
      reason: string,
    ) {
      const sku = chosenSkus.find((s) => (c.stock.get(s._id.toString()) ?? 0) >= 3);
      if (!sku) return;
      const qty = type === 'adjustment_increase' ? 2 : 1;
      await at(dayAt(daysAgo, '20:30'), () =>
        withTransaction((session) =>
          moveStock({
            branchId: c.branch._id,
            skuId: sku._id,
            type,
            qty,
            reason: `[DEMO] ${reason}`,
            performedBy: c.manager._id,
            refType: 'Adjustment',
            session,
          }),
        ),
      );
      c.stock.set(sku._id.toString(), (c.stock.get(sku._id.toString()) ?? 0) + (type === 'adjustment_increase' ? qty : -qty));
    }

    for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo--) {
      const date = dayAt(daysAgo, '12:00');
      const weekend = date.getDay() === 0 || date.getDay() === 6;
      process.stdout.write(`Day -${daysAgo} (${date.toISOString().slice(0, 10)}) `);

      for (const c of ctxs) {
        const shiftCount = Math.min(2, c.defs.length);
        for (let s = 0; s < shiftCount; s++) {
          const def = c.defs[s];
          const isLast = s === shiftCount - 1;
          const shiftEnd = dayAt(daysAgo, def.endTime).getTime();
          // Today: a shift still running right now stays open.
          const leaveOpen = daysAgo === 0 && shiftEnd > now;
          await runShift(c, daysAgo, s, {
            weekendBoost: weekend ? 1.4 : 1,
            leaveOpen,
            isLast,
          });
        }
      }

      await runOnlineOrders(daysAgo);

      // Monthly-ish expenses
      for (const c of ctxs) {
        const exp: [string, string, number][] = [];
        if (daysAgo === DAYS - 1) exp.push(['rent', 'ค่าเช่าพื้นที่', c === ctxs[0] ? 35000 : 22000]);
        if (daysAgo === DAYS - 3) exp.push(['electricity', 'ค่าไฟ', randInt(3200, 4800)], ['water', 'ค่าน้ำ', randInt(250, 450)]);
        if (daysAgo % 7 === 2) exp.push(['advertising', 'ค่าโฆษณา Facebook/IG', randInt(800, 2500)]);
        if (daysAgo % 10 === 4) exp.push(['packaging', 'กล่อง/ซองแพ็คสินค้า', randInt(300, 900)]);
        if (c === onlineCtx && daysAgo % 5 === 1) exp.push(['shipping', 'ค่าขนส่งออเดอร์ออนไลน์', randInt(400, 1200)]);
        for (const [category, description, amount] of exp) {
          const when = new Date(Math.min(dayAt(daysAgo, '18:00').getTime(), now - 30 * MIN));
          await at(when, () =>
            Expense.create({
              branchId: c.branch._id,
              date: when,
              category,
              description: `[DEMO] ${description}`,
              amount: baht(amount),
              recordedBy: c.manager._id,
            }),
          );
          counters.expenses += 1;
        }
      }

      // Transfers & stock adjustments on specific days
      if (ctxs.length >= 2) {
        const [a, b] = ctxs;
        if (daysAgo === 22) await stockTransfer(daysAgo, a, b, 'received');
        if (daysAgo === 14) await stockTransfer(daysAgo, b, a, 'discrepancy');
        if (daysAgo === 9) await stockTransfer(daysAgo, a, b, 'cancelled');
        if (daysAgo === 6) await stockTransfer(daysAgo, a, b, 'in_transit'); // overdue
        if (daysAgo === 1) await stockTransfer(daysAgo, a, b, 'sent');
      }
      if (daysAgo === 15) await stockMove(daysAgo, ctxs[0], 'adjustment_decrease', 'ตรวจนับสต๊อกประจำเดือน ของขาด');
      if (daysAgo === 15) await stockMove(daysAgo, ctxs[0], 'adjustment_increase', 'ตรวจนับสต๊อกประจำเดือน ของเกิน');
      if (daysAgo === 8) await stockMove(daysAgo, ctxs[ctxs.length - 1], 'damage_out', 'กล่องเปียกน้ำ');
      if (daysAgo === 3) await stockMove(daysAgo, ctxs[0], 'internal_use_out', 'ใช้เป็นตัวอย่างให้ลูกค้าทดลอง');

      // Mid-period restock from the second supplier
      if (daysAgo === 12) {
        for (const c of ctxs) {
          const low = chosenSkus.filter((s) => (c.stock.get(s._id.toString()) ?? 0) < 12).slice(0, 15);
          if (low.length === 0) continue;
          const when = dayAt(daysAgo, '10:30');
          await at(when, async () => {
            const items = low.map((sku, i) => ({
              skuId: sku._id.toString(),
              qty: randInt(10, 20),
              unitCost: Math.round((sku.priceRegular * randInt(40, 52)) / 100),
              lot: `LOT-R${String(i + 1).padStart(3, '0')}`,
              expiryDate: new Date(Date.now() + randInt(400, 700) * DAY).toISOString(),
            }));
            const { purchase } = await purchaseService.createPurchase({
              supplierId: supplier2._id.toString(),
              branchId: c.branch._id.toString(),
              invoiceNo: `DEMO-${c.branch.code}-0002`,
              purchaseDate: when.toISOString(),
              vat: Math.round(items.reduce((s, i) => s + i.unitCost * i.qty, 0) * 0.07),
              items,
              createdBy: admin._id.toString(),
            });
            await purchaseService.confirmPurchase(purchase._id.toString(), admin._id.toString());
            for (const it of items) c.stock.set(it.skuId, (c.stock.get(it.skuId) ?? 0) + it.qty);
          });
        }
      }
      console.log(`sales=${counters.sales} orders=${counters.orders}`);
    }

    // A draft purchase waiting to be confirmed
    const draftAt = new Date(Math.min(dayAt(0, '09:30').getTime(), now - 10 * MIN));
    await at(draftAt, () =>
      purchaseService.createPurchase({
        supplierId: supplier2._id.toString(),
        branchId: ctxs[0].branch._id.toString(),
        invoiceNo: 'DEMO-DRAFT-0003',
        purchaseDate: draftAt.toISOString(),
        items: hotSkus.slice(0, 4).map((sku) => ({
          skuId: sku._id.toString(),
          qty: 20,
          unitCost: Math.round(sku.priceRegular * 0.45),
        })),
        createdBy: admin._id.toString(),
      }),
    );
  } finally {
    // --- Rebase timestamps (also after a failure, so partial data isn't left dated "now") ---
    // DailySales rows written during the run are keyed by the real "today"; drop and rebuild them after rebasing.
    await DailySales.deleteMany({ createdAt: { $gte: new Date(scriptStart) } });
    console.log(`\nRebasing timestamps across ${windows.length} operations...`);
    await rebaseAllTimestamps();
  }

  const byBranchDay = new Map<string, { branchId: string; day: Date }>();
  for (const s of demoSessions) {
    const day = startOfDay(s.openedAt);
    byBranchDay.set(`${s.branchId}-${day.getTime()}`, {
      branchId: s.branchId,
      day,
    });
  }
  for (const { branchId, day } of byBranchDay.values()) {
    const sessions = await ShiftSession.find({
      branchId,
      openedAt: { $gte: day, $lt: new Date(day.getTime() + DAY) },
    });
    const allApproved = sessions.length > 0 && sessions.every((s) => s.status === 'approved');
    await DailySales.findOneAndUpdate(
      { branchId, date: day },
      { $set: { closedStatus: allApproved ? 'closed' : 'partial' } },
      { upsert: true, timestamps: false },
    );
  }

  console.log('\n=== Demo seed complete ===');
  console.log(counters);
  console.log(`SKUs used: ${skuById.size}`);
  await disconnectDb();
}

main().catch(async (err) => {
  console.error('Demo seed failed:', err);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
