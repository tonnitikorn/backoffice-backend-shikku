import { makeBranch, makeSkuWithStock } from './fixtures';
import { evaluateCart, listPromotionOptions } from '../services/promotionService';
import { Promotion } from '../models/Promotion';
import { Coupon } from '../models/Coupon';

describe('Coupon-backed promotions', () => {
  test('apply only when the coupon code is entered', async () => {
    const branch = await makeBranch();
    const branchId = branch._id.toString();
    const { sku } = await makeSkuWithStock(branchId, { price: 10000 });
    const promo = await Promotion.create({
      name: 'welcome',
      type: 'amount',
      startAt: new Date(Date.now() - 86400000),
      endAt: new Date(Date.now() + 86400000),
      stackable: true,
      config: { amountOff: 5000 },
    });
    await Coupon.create({ code: 'WELCOME50', promotionId: promo._id });

    const plain = await evaluateCart({ branchId, channel: 'line', lines: [{ sku, qty: 2 }] });
    expect(plain).toMatchObject({ discountTotal: 0, netTotal: 20000 });
    expect(plain.lines[0].promotionId).toBeUndefined();

    const withCoupon = await evaluateCart({ branchId, channel: 'store', lines: [{ sku, qty: 2 }], couponCode: 'welcome50' });
    expect(withCoupon).toMatchObject({ discountTotal: 5000, netTotal: 15000 });
  });
});

describe('Picked promotions', () => {
  test('nothing applies unless selected; options show what each would save', async () => {
    const branch = await makeBranch();
    const branchId = branch._id.toString();
    const { sku } = await makeSkuWithStock(branchId, { price: 10000 });
    const window = { startAt: new Date(Date.now() - 86400000), endAt: new Date(Date.now() + 86400000) };
    const tenOff = await Promotion.create({ name: '10%', type: 'percent', ...window, config: { percentOff: 10 } });
    const storeOnly = await Promotion.create({ name: 'store', type: 'amount', ...window, scopeChannels: ['store'], config: { amountOff: 1000 } });
    await Promotion.create({ name: 'spend', type: 'spend_x_get_y', ...window, config: { spendThreshold: 50000, spendDiscountAmount: 5000 } });

    const lines = [{ sku, qty: 2 }];
    expect(await evaluateCart({ branchId, channel: 'line', lines })).toMatchObject({ discountTotal: 0, netTotal: 20000 });

    const picked = await evaluateCart({ branchId, channel: 'line', lines, promotionIds: [tenOff._id.toString()] });
    expect(picked).toMatchObject({ discountTotal: 2000, netTotal: 18000 });
    expect(picked.lines[0].promotionId).toBe(tenOff._id.toString());

    await expect(evaluateCart({ branchId, channel: 'line', lines, promotionIds: [storeOnly._id.toString()] })).rejects.toThrow();

    const options = await listPromotionOptions({ branchId, channel: 'line', lines });
    expect(options.map((o) => [o.name, o.saving])).toEqual([
      ['10%', 2000],
      ['spend', 0],
    ]);
  });
});
