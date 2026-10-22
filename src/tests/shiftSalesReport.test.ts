import { makeBranch, makeUser, makeSkuWithStock } from './fixtures';
import * as shiftService from '../services/shiftService';
import * as saleService from '../services/saleService';
import * as reportService from '../services/reportService';
import { ShiftDefinition } from '../models/ShiftDefinition';
import { ShiftSession } from '../models/ShiftSession';

describe('Sales report by shift', () => {
  test('groups sales per shift session and filters by shift definition', async () => {
    const branch = await makeBranch();
    const branchId = branch._id.toString();
    const { user: staff } = await makeUser('staff', [branchId]);
    const { user: admin } = await makeUser('admin');
    const { sku } = await makeSkuWithStock(branchId, { qty: 20, price: 10000 });
    const morning = await ShiftDefinition.create({ branchId, name: 'เช้า', startTime: '09:00', endTime: '15:00' });

    const shiftA = await shiftService.openShift({
      branchId,
      userId: staff._id.toString(),
      openingFloat: 100000,
      openingFloatVarianceReason: 'test',
      approverId: admin._id.toString(),
    });
    await ShiftSession.updateOne({ _id: shiftA._id }, { shiftDefinitionId: morning._id });
    await saleService.createSale({
      branchId,
      shiftSessionId: shiftA._id.toString(),
      items: [{ skuId: sku._id.toString(), qty: 2 }],
      payments: [{ method: 'cash', amount: 20000 }],
      idempotencyKey: 'shift-report-a1',
      soldBy: staff._id.toString(),
    });
    await saleService.createSale({
      branchId,
      shiftSessionId: shiftA._id.toString(),
      items: [{ skuId: sku._id.toString(), qty: 1 }],
      payments: [{ method: 'transfer', amount: 10000 }],
      idempotencyKey: 'shift-report-a2',
      soldBy: staff._id.toString(),
    });

    const from = new Date(Date.now() - 86400000);
    const to = new Date(Date.now() + 86400000);

    const all = await reportService.getShiftSalesReport({ branchId, from, to });
    expect(all.rows).toHaveLength(1);
    expect(all.rows[0]).toMatchObject({ saleCount: 2, netTotal: 30000, cash: 20000, transfer: 10000, qr: 0 });
    expect(all.summary).toMatchObject({ shiftCount: 1, saleCount: 2, netAfterRefund: 30000 });

    const onlyMorning = await reportService.getShiftSalesReport({ branchId, from, to, shiftDefinitionId: morning._id.toString() });
    expect(onlyMorning.rows).toHaveLength(1);

    const unscheduled = await reportService.getShiftSalesReport({ branchId, from, to, shiftDefinitionId: 'unscheduled' });
    expect(unscheduled.rows).toHaveLength(0);

    const outOfRange = await reportService.getShiftSalesReport({ branchId, from: new Date(0), to: new Date(1000) });
    expect(outOfRange.summary.saleCount).toBe(0);
  });
});
