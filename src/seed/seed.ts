/* eslint-disable no-console */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db';
import { logger } from '../config/logger';

import { Branch } from '../models/Branch';
import { User } from '../models/User';
import { Category } from '../models/Category';
import { Brand } from '../models/Brand';
import { Product } from '../models/Product';
import { ProductVariant } from '../models/ProductVariant';
import { ProductSku } from '../models/ProductSku';
import { Supplier } from '../models/Supplier';
import { MemberLevel } from '../models/MemberLevel';
import { Customer } from '../models/Customer';
import { Promotion } from '../models/Promotion';
import { Coupon } from '../models/Coupon';
import { ShiftDefinition } from '../models/ShiftDefinition';
import { ShiftSchedule } from '../models/ShiftSchedule';
import { Setting, SETTING_KEYS } from '../models/Setting';

import { hashPassword } from '../services/authService';
import * as skuGen from '../services/skuGenerationService';
import * as purchaseService from '../services/purchaseService';
import * as saleService from '../services/saleService';
import * as shiftService from '../services/shiftService';
import * as cashMovementService from '../services/cashMovementService';
import * as transferService from '../services/transferService';
import * as refundService from '../services/refundService';
import * as orderService from '../services/orderService';

const COLLECTIONS_TO_WIPE = [
  'branches', 'users', 'categories', 'brands', 'products', 'productvariants', 'productskus',
  'skugenerationbatches', 'inventories', 'inventorytransactions', 'stockchannelsettings',
  'suppliers', 'purchases', 'purchaseitems', 'sales', 'saleitems', 'orders', 'orderitems',
  'payments', 'refunds', 'refunditems', 'customers', 'memberlevels', 'promotions', 'coupons',
  'shiftdefinitions', 'shiftschedules', 'shiftsessions', 'cashmovements', 'dailysales',
  'stocktransfers', 'stocktransferitems', 'expenses', 'notifications', 'auditlogs', 'settings',
];

async function wipeDatabase() {
  const db = mongoose.connection.db!;
  for (const name of COLLECTIONS_TO_WIPE) {
    await db.collection(name).deleteMany({}).catch(() => undefined);
  }
  logger.info('Existing seed collections wiped');
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to wipe and seed with NODE_ENV=production');
  }
  await connectDb();
  await wipeDatabase();

  // --- Settings ---
  await Setting.create({ key: SETTING_KEYS.openingFloatStandardByBranch, value: {} });

  // --- Branches ---
  const branch1 = await Branch.create({ code: 'SIAM', name: 'สาขาสยาม', address: 'สยามสแควร์ กรุงเทพฯ', phone: '020000001', isDefaultOnlineBranch: true });
  const branch2 = await Branch.create({ code: 'THONGLOR', name: 'สาขาทองหล่อ', address: 'ทองหล่อ กรุงเทพฯ', phone: '020000002' });

  await Setting.findOneAndUpdate(
    { key: SETTING_KEYS.openingFloatStandardByBranch },
    { $set: { value: { [branch1._id.toString()]: 200000, [branch2._id.toString()]: 200000 } } }, // 2,000 THB in satang
  );

  // --- Shift definitions ---
  const morningShift1 = await ShiftDefinition.create({ branchId: branch1._id, name: 'กะเช้า', startTime: '09:00', endTime: '15:00' });
  await ShiftDefinition.create({ branchId: branch1._id, name: 'กะบ่าย', startTime: '15:00', endTime: '21:00' });
  await ShiftDefinition.create({ branchId: branch2._id, name: 'กะเช้า', startTime: '09:00', endTime: '15:00' });
  await ShiftDefinition.create({ branchId: branch2._id, name: 'กะบ่าย', startTime: '15:00', endTime: '21:00' });

  // --- Users ---
  const credentials: { role: string; email: string; password: string }[] = [];
  async function makeUser(name: string, email: string, role: 'admin' | 'branch_manager' | 'staff', branchIds: mongoose.Types.ObjectId[]) {
    const password = `${role}Pass123!`;
    const passwordHash = await hashPassword(password);
    const user = await User.create({ name, email, passwordHash, role, branchIds });
    credentials.push({ role, email, password });
    return user;
  }

  const admin = await makeUser('เจ้าของร้าน', 'admin@shikkulens.local', 'admin', []);
  const manager1 = await makeUser('ผู้จัดการสาขาสยาม', 'manager.siam@shikkulens.local', 'branch_manager', [branch1._id]);
  await makeUser('ผู้จัดการสาขาทองหล่อ', 'manager.thonglor@shikkulens.local', 'branch_manager', [branch2._id]);
  const staff1 = await makeUser('พนักงานสยาม 1', 'staff1.siam@shikkulens.local', 'staff', [branch1._id]);
  await makeUser('พนักงานสยาม 2', 'staff2.siam@shikkulens.local', 'staff', [branch1._id]);
  await makeUser('พนักงานทองหล่อ 1', 'staff1.thonglor@shikkulens.local', 'staff', [branch2._id]);

  // --- Catalog ---
  const lensCategory = await Category.create({ name: 'คอนแทคเลนส์รายเดือน', appliesTo: 'contact_lens' });
  const otherCategory = await Category.create({ name: 'น้ำยาล้างเลนส์', appliesTo: 'other' });
  const brandAcuvue = await Brand.create({ name: 'Acuvue' });
  const brandRenu = await Brand.create({ name: 'Renu' });

  const lensProduct = await Product.create({
    name: 'Acuvue Moist',
    shortCode: 'ACM',
    brandId: brandAcuvue._id,
    categoryId: lensCategory._id,
    type: 'contact_lens',
    seriesName: 'Moist',
    dia: 14.2,
    bc: 8.5,
    wearDurationDays: 30,
    unitOfMeasure: 'piece',
    defaultPriceRegular: 65000, // 650 THB
    defaultCost: 35000,
    defaultMinStockLevel: 5,
  });
  const lensVariant = await ProductVariant.create({ productId: lensProduct._id, colorName: 'Natural' });

  const genResult = await skuGen.generateSkus({
    productId: lensProduct._id.toString(),
    variantId: lensVariant._id.toString(),
    ranges: [{ from: -0.5, to: -6.0, step: 0.25 }],
    createdBy: admin._id.toString(),
  });
  logger.info({ createdCount: genResult.createdSkus.length }, 'Generated contact lens SKUs');
  const firstLensSku = await ProductSku.findOne({ productId: lensProduct._id }).sort({ power: 1 });

  const solutionProduct = await Product.create({
    name: 'Renu Fresh 355ml',
    shortCode: 'RENU',
    brandId: brandRenu._id,
    categoryId: otherCategory._id,
    type: 'other',
    unitOfMeasure: 'bottle',
    defaultPriceRegular: 25000,
    defaultCost: 15000,
    defaultMinStockLevel: 3,
  });
  const solutionSku = await ProductSku.create({
    productId: solutionProduct._id,
    skuCode: 'RENU-355',
    barcode: 'RENU-355',
    priceRegular: 25000,
    cost: 15000,
    minStockLevel: 3,
    unitOfMeasure: 'bottle',
  });

  // --- Supplier + Purchases (stock-in for both branches) ---
  const supplier = await Supplier.create({ name: 'บริษัท คอนแทคเลนส์ ซัพพลาย จำกัด', phone: '021234567', taxId: '0105500000000' });

  for (const branch of [branch1, branch2]) {
    const { purchase } = await purchaseService.createPurchase({
      supplierId: supplier._id.toString(),
      branchId: branch._id.toString(),
      invoiceNo: `INV-${branch.code}-0001`,
      purchaseDate: new Date().toISOString(),
      shippingCost: 5000,
      items: [
        { skuId: firstLensSku!._id.toString(), qty: 50, unitCost: 35000, lot: 'LOT-A', expiryDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 400).toISOString() },
        { skuId: solutionSku._id.toString(), qty: 30, unitCost: 15000, lot: 'LOT-B' },
      ],
      createdBy: admin._id.toString(),
    });
    await purchaseService.confirmPurchase(purchase._id.toString(), admin._id.toString());
  }
  logger.info('Confirmed initial purchases for both branches');

  // --- Member level + customer ---
  const goldLevel = await MemberLevel.create({ name: 'Gold', thresholdSpend: 500000, benefitsDescription: 'ส่วนลดสมาชิก 5%' });
  const customer = await Customer.create({ name: 'คุณลูกค้า ทดสอบ', phone: '0812345678', memberLevelId: goldLevel._id });

  // --- Promotion + coupon ---
  const now = new Date();
  const nextMonth = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30);
  const promo = await Promotion.create({
    name: 'ลด 10% Acuvue Moist',
    type: 'percent',
    scopeSkuIds: [firstLensSku!._id],
    startAt: now,
    endAt: nextMonth,
    stackable: false,
    config: { percentOff: 10 },
  });
  const stackablePromo = await Promotion.create({
    name: 'คูปองต้อนรับ',
    type: 'amount',
    startAt: now,
    endAt: nextMonth,
    stackable: true,
    config: { amountOff: 5000 },
  });
  await Coupon.create({ code: 'WELCOME50', promotionId: stackablePromo._id, usageLimit: 100 });
  logger.info({ promo: promo.name }, 'Created demo promotion + stackable coupon');

  // --- Publish today's schedule for staff1 at branch1, so opening needs no manager approval ---
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  await ShiftSchedule.create({ branchId: branch1._id, userId: staff1._id, shiftDefinitionId: morningShift1._id, date: today, status: 'published', publishedAt: new Date() });

  // --- Simulate a full business day at branch1 ---
  const shift = await shiftService.openShift({ branchId: branch1._id.toString(), userId: staff1._id.toString(), openingFloat: 200000 });
  logger.info({ shiftId: shift._id.toString() }, 'Opened shift for staff1 at branch1');

  const { evaluateCart } = await import('../services/promotionService');
  const quote1 = await evaluateCart({ branchId: branch1._id.toString(), channel: 'store', customerId: customer._id.toString(), lines: [{ sku: firstLensSku!, qty: 2 }] });
  const realSale1 = await saleService.createSale({
    branchId: branch1._id.toString(),
    shiftSessionId: shift._id.toString(),
    customerId: customer._id.toString(),
    items: [{ skuId: firstLensSku!._id.toString(), qty: 2 }],
    payments: [{ method: 'cash', amount: quote1.netTotal }],
    idempotencyKey: 'seed-sale-1',
    soldBy: staff1._id.toString(),
  });
  logger.info({ saleId: realSale1._id.toString(), netTotal: realSale1.netTotal }, 'Created sale #1 (cash)');

  const quote2 = await evaluateCart({
    branchId: branch1._id.toString(),
    channel: 'store',
    lines: [{ sku: firstLensSku!, qty: 1 }, { sku: solutionSku, qty: 1 }],
  });
  const half = Math.floor(quote2.netTotal / 2);
  const sale2 = await saleService.createSale({
    branchId: branch1._id.toString(),
    shiftSessionId: shift._id.toString(),
    items: [{ skuId: firstLensSku!._id.toString(), qty: 1 }, { skuId: solutionSku._id.toString(), qty: 1 }],
    payments: [{ method: 'cash', amount: half }, { method: 'transfer', amount: quote2.netTotal - half, referenceNo: 'TESTREF001' }],
    idempotencyKey: 'seed-sale-2-split',
    soldBy: staff1._id.toString(),
  });
  logger.info({ saleId: sale2._id.toString(), netTotal: sale2.netTotal }, 'Created sale #2 (split payment)');

  await cashMovementService.createCashMovement({
    shiftSessionId: shift._id.toString(),
    type: 'cash_out',
    amount: 5000,
    reason: 'ซื้อวัสดุสิ้นเปลือง',
    performedBy: staff1._id.toString(),
    createExpenseCategory: 'other',
  });

  // --- Stock transfer branch1 -> branch2 ---
  const transfer = await transferService.createTransfer({
    fromBranchId: branch1._id.toString(),
    toBranchId: branch2._id.toString(),
    items: [{ skuId: solutionSku._id.toString(), qty: 5 }],
    sentBy: admin._id.toString(),
  });
  await transferService.markInTransit(transfer._id.toString(), 'Grab Express', admin._id.toString());
  const { StockTransferItem } = await import('../models/StockTransferItem');
  const transferItems = await StockTransferItem.find({ transferId: transfer._id });
  await transferService.receiveTransfer(transfer._id.toString(), {
    items: transferItems.map((i) => ({ itemId: i._id.toString(), qtyReceived: i.qtySent })),
    userId: manager1._id.toString(),
  });
  logger.info({ transferId: transfer._id.toString() }, 'Completed stock transfer branch1 -> branch2');

  // --- Refund: return 1 unit from sale #1, sealed condition ---
  const { SaleItem } = await import('../models/SaleItem');
  const sale1Items = await SaleItem.find({ saleId: realSale1._id });
  const refund = await refundService.createRefundRequest({
    originalType: 'Sale',
    originalId: realSale1._id.toString(),
    type: 'refund',
    items: [{ originalItemId: sale1Items[0]._id.toString(), qty: 1, condition: 'sealed' }],
    reason: 'ลูกค้าเปลี่ยนใจ ไม่เปิดกล่อง',
    requestedBy: staff1._id.toString(),
  });
  await refundService.approveRefund(refund._id.toString(), manager1._id.toString(), [{ method: 'cash', amount: refund.totalRefundAmount }]);
  logger.info({ refundId: refund._id.toString() }, 'Approved refund for sale #1');

  // --- Close and approve the shift ---
  const totals = await shiftService.computeShiftExpectedTotals(shift._id.toString());
  const closed = await shiftService.closeShift({
    shiftSessionId: shift._id.toString(),
    userId: staff1._id.toString(),
    closingCashCounted: totals.systemCashExpected,
    closingTransferCounted: totals.systemTransferExpected,
    carryForwardFloat: 200000,
    cashHandedIn: totals.systemCashExpected - 200000,
  });
  await shiftService.approveShiftClose(closed._id.toString(), manager1._id.toString());
  logger.info('Closed and approved shift for staff1');

  // --- Online order (admin logs a LINE chat sale) ---
  const order = await orderService.createOrder({
    branchId: branch1._id.toString(),
    customerId: customer._id.toString(),
    channel: 'line',
    items: [{ skuId: firstLensSku!._id.toString(), qty: 1 }],
    shippingMethod: 'Grab Express',
    shippingAddress: '123 ถนนสุขุมวิท กรุงเทพฯ',
    idempotencyKey: 'seed-order-1',
    createdBy: admin._id.toString(),
    payments: [{ method: 'transfer', amount: firstLensSku!.priceRegular, referenceNo: 'LINEPAY001' }],
  });
  await orderService.updateOrderStatus(order._id.toString(), 'packed', admin._id.toString());
  await orderService.updateOrderStatus(order._id.toString(), 'shipped', admin._id.toString());
  logger.info({ orderId: order._id.toString() }, 'Created and shipped an online (LINE) order');

  console.log('\n=== Seed complete ===');
  console.log('Branches:', branch1.name, branch2.name);
  console.log('\nLogin credentials:');
  for (const c of credentials) console.log(`  [${c.role}] ${c.email} / ${c.password}`);
  console.log(`\nSale #1: ${realSale1._id} (net ${realSale1.netTotal / 100} THB)`);
  console.log(`Sale #2 (split payment): ${sale2._id} (net ${sale2.netTotal / 100} THB)`);
  console.log(`Refund: ${refund._id} (${refund.totalRefundAmount / 100} THB)`);
  console.log(`Stock transfer: ${transfer._id}`);
  console.log(`Online order: ${order._id}`);
  console.log(`Shift session (closed+approved): ${shift._id}`);

  await disconnectDb();
}

main().catch(async (err) => {
  logger.error({ err }, 'Seed failed');
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
