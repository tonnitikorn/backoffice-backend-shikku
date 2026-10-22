import { makeBranch, makeUser, makeSkuWithStock } from './fixtures';
import * as shiftService from '../services/shiftService';
import * as saleService from '../services/saleService';
import * as stockCountService from '../services/stockCountService';
import { StockCountGroup } from '../models/StockCountGroup';
import { ProductSku } from '../models/ProductSku';
import { Inventory } from '../models/Inventory';
import { Product } from '../models/Product';
import { withTransaction } from '../config/db';
import { moveStock } from '../services/inventoryService';

describe('Per-shift stock sheet and summary', () => {
  test('counts before/after per group, tallies sales by group/price/channel and blocks close without the after count', async () => {
    const branch = await makeBranch();
    const branchId = branch._id.toString();
    const { user: staff } = await makeUser('staff', [branchId]);
    const { user: admin } = await makeUser('admin');

    // One lens model with a plano and a -1.00 SKU, plus an accessory.
    const { product: lens, sku: planoSku } = await makeSkuWithStock(branchId, { qty: 20, price: 9900 });
    await ProductSku.updateOne({ _id: planoSku._id }, { power: 0 });
    const minusSku = await ProductSku.create({
      productId: lens._id,
      skuCode: `M100-${Date.now()}`,
      barcode: `M100-${Date.now()}`,
      power: -1,
      priceRegular: 10900,
      cost: 4000,
      minStockLevel: 0,
    });
    await Inventory.create({ branchId, skuId: minusSku._id, qtyOnHand: 30 });
    const { product: caseProduct, sku: caseSku } = await makeSkuWithStock(branchId, { qty: 10, price: 3900 });

    await Product.updateOne({ _id: caseProduct._id }, { type: 'other' });

    const plano = await StockCountGroup.create({ name: 'สายตาปกติ 99฿', productIds: [lens._id], powerFilter: 'plano', unitLabel: 'คู่', sortOrder: 10 });
    const minus = await StockCountGroup.create({ name: 'สายตาสั้น 109฿', productIds: [lens._id], powerFilter: 'non_plano', unitLabel: 'คู่', sortOrder: 20 });
    const cases = await StockCountGroup.create({ name: 'ตลับ 39฿', productIds: [caseProduct._id], unitLabel: 'ชิ้น', sortOrder: 30 });

    const shift = await shiftService.openShift({
      branchId,
      userId: staff._id.toString(),
      openingFloat: 100000,
      openingFloatVarianceReason: 'test',
      approverId: admin._id.toString(),
    });
    const shiftId = shift._id.toString();

    await expect(
      stockCountService.recordShiftStockCount({
        shiftSessionId: shiftId,
        phase: 'open',
        lines: [{ groupId: plano._id.toString(), countedQty: 20 }],
        userId: staff._id.toString(),
      }),
    ).rejects.toThrow(/missing/);

    await stockCountService.recordShiftStockCount({
      shiftSessionId: shiftId,
      phase: 'open',
      lines: [
        { groupId: plano._id.toString(), countedQty: 20 },
        { groupId: minus._id.toString(), countedQty: 30 },
        { groupId: cases._id.toString(), countedQty: 10 },
      ],
      userId: staff._id.toString(),
    });

    // Store: 2 plano at 99, 1 plano haggled to 95, 3 minus at 109. Grab: 2 plano. Giveaway: 2 cases (no payment).
    await saleService.createSale({
      branchId,
      shiftSessionId: shiftId,
      items: [
        { skuId: planoSku._id.toString(), qty: 2 },
        { skuId: minusSku._id.toString(), qty: 3 },
      ],
      payments: [{ method: 'transfer', amount: 2 * 9900 + 3 * 10900 }],
      idempotencyKey: 'ssc-1',
      soldBy: staff._id.toString(),
    });
    await expect(
      saleService.createSale({
        branchId,
        shiftSessionId: shiftId,
        items: [{ skuId: planoSku._id.toString(), qty: 1, unitPriceOverride: 9500 }],
        payments: [{ method: 'cash', amount: 9500 }],
        idempotencyKey: 'ssc-2-noreason',
        soldBy: staff._id.toString(),
      }),
    ).rejects.toThrow(/reason/);
    await saleService.createSale({
      branchId,
      shiftSessionId: shiftId,
      items: [{ skuId: planoSku._id.toString(), qty: 1, unitPriceOverride: 9500, overrideReason: 'ลูกค้าประจำ' }],
      payments: [{ method: 'cash', amount: 9500 }],
      idempotencyKey: 'ssc-2',
      soldBy: staff._id.toString(),
    });
    await saleService.createSale({
      branchId,
      shiftSessionId: shiftId,
      channel: 'grab',
      items: [{ skuId: planoSku._id.toString(), qty: 2 }],
      payments: [{ method: 'platform', amount: 19800 }],
      idempotencyKey: 'ssc-3',
      soldBy: staff._id.toString(),
    });
    await saleService.createSale({
      branchId,
      shiftSessionId: shiftId,
      items: [{ skuId: caseSku._id.toString(), qty: 2, unitPriceOverride: 0, overrideReason: 'รีวิว' }],
      payments: [],
      idempotencyKey: 'ssc-4',
      soldBy: staff._id.toString(),
    });

    await expect(
      shiftService.closeShift({
        shiftSessionId: shiftId,
        userId: staff._id.toString(),
        closingCashCounted: 109500,
        closingTransferCounted: 52500,
        carryForwardFloat: 100000,
        cashHandedIn: 9500,
      }),
    ).rejects.toThrow(/Stock/);

    // After count: plano 20-5=15 but staff finds 14 (1 missing).
    await stockCountService.recordShiftStockCount({
      shiftSessionId: shiftId,
      phase: 'close',
      lines: [
        { groupId: plano._id.toString(), countedQty: 14 },
        { groupId: minus._id.toString(), countedQty: 27 },
        { groupId: cases._id.toString(), countedQty: 8 },
      ],
      userId: staff._id.toString(),
    });

    const summary = await stockCountService.getShiftSummary(shiftId);
    const line = (group: string, channel: string, price: number) =>
      summary.salesLines.find((l) => l.groupName === group && l.channel === channel && l.unitPrice === price);
    expect(line('สายตาปกติ 99฿', 'store', 9900)?.qty).toBe(2);
    expect(line('สายตาปกติ 99฿', 'store', 9500)?.qty).toBe(1);
    expect(line('สายตาปกติ 99฿', 'grab', 9900)?.qty).toBe(2);
    expect(line('สายตาสั้น 109฿', 'store', 10900)).toMatchObject({ qty: 3, amount: 32700 });
    expect(line('ตลับ 39฿', 'store', 0)?.qty).toBe(2);
    expect(summary.giveaways).toEqual([expect.objectContaining({ qty: 2, reason: 'รีวิว' })]);
    expect(summary.overrides).toEqual([expect.objectContaining({ unitPrice: 9500, regularPrice: 9900, reason: 'ลูกค้าประจำ' })]);
    expect(summary.totals).toMatchObject({
      lensQty: 8,
      grossTotal: 19800 + 32700 + 9500 + 19800,
      byChannel: { store: 19800 + 32700 + 9500, grab: 19800 },
      byPayment: expect.objectContaining({ platform: 19800, cash: 9500 }),
    });

    const stock = (name: string) => summary.stock.find((s) => s.name === name)!;
    expect(stock('สายตาปกติ 99฿')).toMatchObject({ before: 20, saleOut: 5, expectedAfter: 15, after: 14, variance: -1 });
    expect(stock('สายตาสั้น 109฿')).toMatchObject({ before: 30, expectedAfter: 27, after: 27, variance: 0 });
    expect(stock('ตลับ 39฿')).toMatchObject({ before: 10, expectedAfter: 8, variance: 0 });

    // Grab money never lands in the drawer or shop account.
    const totals = await shiftService.computeShiftExpectedTotals(shiftId);
    expect(totals.systemCashExpected).toBe(100000 + 9500);
    expect(totals.systemTransferExpected).toBe(2 * 9900 + 3 * 10900);

    const closed = await shiftService.closeShift({
      shiftSessionId: shiftId,
      userId: staff._id.toString(),
      closingCashCounted: 109500,
      closingTransferCounted: 52500,
      carryForwardFloat: 100000,
      cashHandedIn: 9500,
    });
    expect(closed.status).toBe('pending_review');

    // Next shift: 3 plano pairs arrive between shifts, then the "before" count is 1 short of the handover.
    await withTransaction((session) =>
      moveStock({ branchId, skuId: planoSku._id, type: 'adjustment_increase', qty: 3, reason: 'delivery', performedBy: admin._id, session }),
    );
    const next = await shiftService.openShift({ branchId, userId: staff._id.toString(), openingFloat: 100000, openingFloatVarianceReason: 'test', approverId: admin._id.toString() });
    const ref = await stockCountService.getCountReference(next._id);
    expect(ref.previous?.shiftSessionId.toString()).toBe(shiftId);
    expect(ref.lines.find((l) => l.groupId === plano._id.toString())).toMatchObject({ previousAfter: 14, movedSincePrevious: 3, expectedBefore: 17, before: null });

    const { handover } = await stockCountService.recordShiftStockCount({
      shiftSessionId: next._id.toString(),
      phase: 'open',
      lines: [
        { groupId: plano._id.toString(), countedQty: 16 },
        { groupId: minus._id.toString(), countedQty: 27 },
        { groupId: cases._id.toString(), countedQty: 8 },
      ],
      userId: staff._id.toString(),
    });
    expect(handover?.previous?.shiftSessionId.toString()).toBe(shiftId);
    expect(handover?.mismatchCount).toBe(1);
    expect(handover?.lines.find((l) => l.name === 'สายตาปกติ 99฿')).toMatchObject({ previousAfter: 14, movedBetween: 3, expected: 17, counted: 16, diff: -1 });
    expect(handover?.lines.find((l) => l.name === 'สายตาสั้น 109฿')).toMatchObject({ expected: 27, diff: 0 });
    expect((await stockCountService.getShiftSummary(next._id.toString())).handover?.mismatchCount).toBe(1);

    // After the "before" count, the reference for "after selling" starts from what was counted.
    const ref2 = await stockCountService.getCountReference(next._id);
    expect(ref2.lines.find((l) => l.groupId === plano._id.toString())).toMatchObject({ before: 16, movedSinceBefore: 0, expectedAfter: 16 });
  });
});
