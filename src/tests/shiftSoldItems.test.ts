import { makeBranch, makeUser, makeSkuWithStock } from './fixtures';
import * as shiftService from '../services/shiftService';
import * as saleService from '../services/saleService';
import * as orderService from '../services/orderService';
import * as stockCountService from '../services/stockCountService';

describe('Sold items for a shift (POS)', () => {
  test('lists products/SKUs sold and bills, newest first', async () => {
    const branch = await makeBranch();
    const branchId = branch._id.toString();
    const { user: staff } = await makeUser('staff', [branchId]);
    const { user: admin } = await makeUser('admin');
    const { sku: skuA } = await makeSkuWithStock(branchId, { qty: 20, price: 10000 });
    const { sku: skuB } = await makeSkuWithStock(branchId, { qty: 20, price: 5000 });

    const shift = await shiftService.openShift({
      branchId,
      userId: staff._id.toString(),
      openingFloat: 0,
      openingFloatVarianceReason: 'test',
      approverId: admin._id.toString(),
    });
    const shiftId = shift._id.toString();

    const empty = await shiftService.getShiftSoldItems(shiftId);
    expect(empty.products).toHaveLength(0);
    expect(empty.totals.saleCount).toBe(0);

    await saleService.createSale({
      branchId,
      shiftSessionId: shiftId,
      items: [{ skuId: skuA._id.toString(), qty: 2 }],
      payments: [{ method: 'cash', amount: 20000 }],
      idempotencyKey: 'sold-items-1',
      soldBy: staff._id.toString(),
    });
    await saleService.createSale({
      branchId,
      shiftSessionId: shiftId,
      items: [
        { skuId: skuA._id.toString(), qty: 1 },
        { skuId: skuB._id.toString(), qty: 1 },
      ],
      payments: [{ method: 'transfer', amount: 15000 }],
      idempotencyKey: 'sold-items-2',
      soldBy: staff._id.toString(),
    });

    const result = await shiftService.getShiftSoldItems(shiftId);
    expect(result.totals).toMatchObject({ saleCount: 2, itemQty: 4, netTotal: 35000 });
    expect(result.products).toHaveLength(2);
    expect(result.products[0]).toMatchObject({ qty: 3, amount: 30000 });
    expect(result.products[0].skus[0]).toMatchObject({ skuCode: skuA.skuCode, qty: 3 });
    expect(result.products[1]).toMatchObject({ qty: 1, amount: 5000 });

    expect(result.bills).toHaveLength(2);
    expect(result.bills[0].items).toHaveLength(2);
    expect(result.bills[0].payments).toEqual([{ method: 'transfer', amount: 15000 }]);
    expect(result.bills[1].items[0]).toMatchObject({ qty: 2, lineTotal: 20000 });
  });

  test('online orders logged during an open shift join it as the "online" bucket', async () => {
    const branch = await makeBranch();
    const branchId = branch._id.toString();
    const { user: staff } = await makeUser('staff', [branchId]);
    const { user: admin } = await makeUser('admin');
    const { sku } = await makeSkuWithStock(branchId, { qty: 20, price: 10000 });

    const before = await orderService.createOrder({
      branchId,
      channel: 'line',
      items: [{ skuId: sku._id.toString(), qty: 1 }],
      idempotencyKey: 'online-no-shift',
      createdBy: admin._id.toString(),
    });
    expect(before.shiftSessionId).toBeUndefined();

    const shift = await shiftService.openShift({
      branchId,
      userId: staff._id.toString(),
      openingFloat: 0,
      openingFloatVarianceReason: 'test',
      approverId: admin._id.toString(),
    });
    const shiftId = shift._id.toString();

    await saleService.createSale({
      branchId,
      shiftSessionId: shiftId,
      items: [{ skuId: sku._id.toString(), qty: 1 }],
      payments: [{ method: 'cash', amount: 10000 }],
      idempotencyKey: 'bucket-store',
      soldBy: staff._id.toString(),
    });
    await saleService.createSale({
      branchId,
      shiftSessionId: shiftId,
      channel: 'grab',
      items: [{ skuId: sku._id.toString(), qty: 1 }],
      payments: [{ method: 'platform', amount: 10000 }],
      idempotencyKey: 'bucket-grab',
      soldBy: staff._id.toString(),
    });
    const order = await orderService.createOrder({
      branchId,
      channel: 'facebook',
      items: [{ skuId: sku._id.toString(), qty: 2 }],
      payments: [{ method: 'transfer', amount: 20000 }],
      idempotencyKey: 'bucket-online',
      createdBy: admin._id.toString(),
    });
    expect(order.shiftSessionId?.toString()).toBe(shiftId);
    const cancelled = await orderService.createOrder({
      branchId,
      channel: 'line',
      items: [{ skuId: sku._id.toString(), qty: 1 }],
      idempotencyKey: 'bucket-cancelled',
      createdBy: admin._id.toString(),
    });
    await orderService.updateOrderStatus(cancelled._id.toString(), 'cancelled', admin._id.toString());

    const sold = await shiftService.getShiftSoldItems(shiftId);
    expect(sold.totals).toMatchObject({ saleCount: 3, itemQty: 4, netTotal: 40000, byBucket: { store: 10000, grab: 10000, online: 20000 } });
    expect(sold.products[0].qtyByBucket).toEqual({ store: 1, grab: 1, online: 2 });
    expect(sold.bills.find((b) => b.source === 'online_order')).toMatchObject({ bucket: 'online', channel: 'facebook', netTotal: 20000 });

    const summary = await stockCountService.getShiftSummary(shiftId);
    expect(summary.totals).toMatchObject({ saleCount: 3, onlineOrderCount: 1, grossTotal: 40000, byBucket: { store: 10000, grab: 10000, online: 20000 } });
    expect(summary.totals.byPayment).toMatchObject({ cash: 10000, platform: 10000, transfer: 20000 });
    expect(summary.salesLines.map((l) => l.channel).sort()).toEqual(['grab', 'online', 'store']);
  });
});
