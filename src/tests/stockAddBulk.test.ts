import request from 'supertest';
import { createApp } from '../app';
import { makeBranch, makeSkuWithStock, makeUser } from './fixtures';
import { Inventory } from '../models/Inventory';
import { InventoryTransaction } from '../models/InventoryTransaction';

const app = createApp();

describe('POST /api/stock/add-bulk', () => {
  test('adds each quantity on top of current stock and logs one entry per SKU', async () => {
    const branch = await makeBranch();
    const branchId = branch._id.toString();
    const { token } = await makeUser('admin');
    const { sku: a } = await makeSkuWithStock(branchId, { qty: 3 });
    const { sku: b } = await makeSkuWithStock(branchId, { qty: 0 });

    const res = await request(app)
      .post('/api/stock/add-bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({
        branchId,
        reason: 'เติมสต๊อก',
        items: [
          { skuId: a._id.toString(), qty: 2 },
          { skuId: b._id.toString(), qty: 5 },
          { skuId: a._id.toString(), qty: 1 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skuCount: 2, totalQty: 8 });
    expect((await Inventory.findOne({ branchId, skuId: a._id }))?.qtyOnHand).toBe(6);
    expect((await Inventory.findOne({ branchId, skuId: b._id }))?.qtyOnHand).toBe(5);
    expect(await InventoryTransaction.countDocuments({ branchId, type: 'adjustment_increase' })).toBe(2);
  });

  test('an unknown SKU rejects the whole request', async () => {
    const branch = await makeBranch();
    const branchId = branch._id.toString();
    const { token } = await makeUser('admin');
    const { sku } = await makeSkuWithStock(branchId, { qty: 3 });

    const res = await request(app)
      .post('/api/stock/add-bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId, reason: 'x', items: [{ skuId: sku._id.toString(), qty: 2 }, { skuId: '0123456789abcdef01234567', qty: 1 }] });

    expect(res.status).toBe(400);
    expect((await Inventory.findOne({ branchId, skuId: sku._id }))?.qtyOnHand).toBe(3);
  });

  test('staff cannot top up stock', async () => {
    const branch = await makeBranch();
    const branchId = branch._id.toString();
    const { token } = await makeUser('staff', [branchId]);
    const { sku } = await makeSkuWithStock(branchId);
    const res = await request(app)
      .post('/api/stock/add-bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId, reason: 'x', items: [{ skuId: sku._id.toString(), qty: 1 }] });
    expect(res.status).toBe(403);
  });
});
