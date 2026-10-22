import { makeBranch, makeUser, makeSkuWithStock } from './fixtures';
import * as shiftService from '../services/shiftService';
import * as saleService from '../services/saleService';
import * as cashMovementService from '../services/cashMovementService';

describe('Shift close cash math (spec B9)', () => {
  test('expected cash = opening float + cash sales + cash in - cash out', async () => {
    const branch = await makeBranch();
    const { user: staff } = await makeUser('staff', [branch._id.toString()]);
    const { user: admin } = await makeUser('admin');
    const { sku } = await makeSkuWithStock(branch._id.toString(), { qty: 10, price: 10000 });

    const shift = await shiftService.openShift({
      branchId: branch._id.toString(),
      userId: staff._id.toString(),
      openingFloat: 100000,
      openingFloatVarianceReason: 'Standard float for this test branch',
      approverId: admin._id.toString(),
    });

    await saleService.createSale({
      branchId: branch._id.toString(),
      shiftSessionId: shift._id.toString(),
      items: [{ skuId: sku._id.toString(), qty: 2 }],
      payments: [{ method: 'cash', amount: 20000 }],
      idempotencyKey: 'shift-close-sale-1',
      soldBy: staff._id.toString(),
    });

    await cashMovementService.createCashMovement({
      shiftSessionId: shift._id.toString(),
      type: 'cash_out',
      amount: 5000,
      reason: 'petty expense',
      performedBy: staff._id.toString(),
    });

    const totals = await shiftService.computeShiftExpectedTotals(shift._id.toString());
    // 100000 opening + 20000 cash sales - 5000 cash out = 115000
    expect(totals.systemCashExpected).toBe(115000);

    await expect(
      shiftService.closeShift({
        shiftSessionId: shift._id.toString(),
        userId: staff._id.toString(),
        closingCashCounted: 114000, // off by 1000, no reason given
        closingTransferCounted: 0,
        carryForwardFloat: 100000,
        cashHandedIn: 14000,
      }),
    ).rejects.toThrow(/reason is required/);

    const closed = await shiftService.closeShift({
      shiftSessionId: shift._id.toString(),
      userId: staff._id.toString(),
      closingCashCounted: 115000,
      closingTransferCounted: 0,
      carryForwardFloat: 100000,
      cashHandedIn: 15000,
    });

    expect(closed.status).toBe('pending_review');
    expect(closed.cashVariance).toBe(0);
  });
});
