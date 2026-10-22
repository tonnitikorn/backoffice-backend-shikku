import { makeBranch, makeUser, makeSkuWithStock } from './fixtures';
import * as shiftService from '../services/shiftService';
import * as saleService from '../services/saleService';
import { Inventory } from '../models/Inventory';

describe('Atomic stock decrement under concurrency (spec B6)', () => {
  test('two simultaneous sales of the last unit — exactly one succeeds', async () => {
    const branch = await makeBranch();
    const { user: staff } = await makeUser('staff', [branch._id.toString()]);
    const { user: admin } = await makeUser('admin');
    const { sku } = await makeSkuWithStock(branch._id.toString(), { qty: 1 });

    const shift = await shiftService.openShift({
      branchId: branch._id.toString(),
      userId: staff._id.toString(),
      openingFloat: 0,
      approverId: admin._id.toString(),
    });

    const attempt = (key: string) =>
      saleService.createSale({
        branchId: branch._id.toString(),
        shiftSessionId: shift._id.toString(),
        items: [{ skuId: sku._id.toString(), qty: 1 }],
        payments: [{ method: 'cash', amount: sku.priceRegular }],
        idempotencyKey: key,
        soldBy: staff._id.toString(),
      });

    const results = await Promise.allSettled([attempt('race-a'), attempt('race-b')]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const inventory = await Inventory.findOne({ branchId: branch._id, skuId: sku._id });
    expect(inventory?.qtyOnHand).toBe(0);
  });
});
