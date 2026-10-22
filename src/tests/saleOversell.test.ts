import { makeBranch, makeUser, makeSkuWithStock } from './fixtures';
import * as shiftService from '../services/shiftService';
import * as saleService from '../services/saleService';
import { getShiftSummary } from '../services/stockCountService';
import { Inventory } from '../models/Inventory';
import { SaleItem } from '../models/SaleItem';

describe('POS oversell when the system count is short', () => {
  async function setup(qty: number) {
    const branch = await makeBranch();
    const { user: staff } = await makeUser('staff', [branch._id.toString()]);
    const { user: admin } = await makeUser('admin');
    const { sku } = await makeSkuWithStock(branch._id.toString(), { qty });
    const shift = await shiftService.openShift({
      branchId: branch._id.toString(),
      userId: staff._id.toString(),
      openingFloat: 0,
      approverId: admin._id.toString(),
    });
    const sell = (key: string, n: number, allowOversell?: boolean) =>
      saleService.createSale({
        branchId: branch._id.toString(),
        shiftSessionId: shift._id.toString(),
        items: [{ skuId: sku._id.toString(), qty: n, allowOversell }],
        payments: [{ method: 'cash', amount: sku.priceRegular * n }],
        idempotencyKey: key,
        soldBy: staff._id.toString(),
      });
    return { branch, sku, shift, sell };
  }

  test('without confirmation a short sale is still rejected', async () => {
    const { sell } = await setup(0);
    await expect(sell('os-strict', 1)).rejects.toThrow(/Insufficient stock/);
  });

  test('confirmed oversell goes negative and is flagged on the line and in the shift summary', async () => {
    const { branch, sku, shift, sell } = await setup(1);
    const sale = await sell('os-ok', 3, true);

    const inventory = await Inventory.findOne({ branchId: branch._id, skuId: sku._id });
    expect(inventory?.qtyOnHand).toBe(-2);

    const [line] = await SaleItem.find({ saleId: sale._id });
    expect(line.oversoldQty).toBe(2);

    const summary = await getShiftSummary(shift._id.toString());
    expect(summary.oversold).toEqual([expect.objectContaining({ skuCode: sku.skuCode, qty: 2 })]);
  });

  test('confirmed sale with enough stock is not flagged', async () => {
    const { sku, sell } = await setup(5);
    const sale = await sell('os-enough', 2, true);
    const [line] = await SaleItem.find({ saleId: sale._id, skuId: sku._id });
    expect(line.oversoldQty).toBeUndefined();
  });
});
