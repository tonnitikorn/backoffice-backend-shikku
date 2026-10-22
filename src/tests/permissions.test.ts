import request from 'supertest';
import { createApp } from '../app';
import { makeBranch, makeUser, makeSkuWithStock } from './fixtures';

const app = createApp();

describe('RBAC enforcement (spec B3)', () => {
  test('staff never receives the cost field for a SKU', async () => {
    const branch = await makeBranch();
    const { user: staff, token } = await makeUser('staff', [branch._id.toString()]);
    void staff;
    const { product } = await makeSkuWithStock(branch._id.toString());

    const res = await request(app).get(`/api/products/${product._id}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.skus).toHaveLength(1);
    expect(res.body.skus[0]).not.toHaveProperty('cost');
  });

  test('admin does receive the cost field', async () => {
    const branch = await makeBranch();
    const { token } = await makeUser('admin');
    const { product } = await makeSkuWithStock(branch._id.toString());

    const res = await request(app).get(`/api/products/${product._id}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.skus[0]).toHaveProperty('cost');
  });

  test('staff cannot act on a branch they are not assigned to', async () => {
    const ownBranch = await makeBranch();
    const otherBranch = await makeBranch();
    const { token } = await makeUser('staff', [ownBranch._id.toString()]);
    const { sku } = await makeSkuWithStock(otherBranch._id.toString());

    const res = await request(app)
      .post('/api/stock/write-off')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: otherBranch._id.toString(), skuId: sku._id.toString(), qty: 1, type: 'damage_out', reason: 'test' });

    expect(res.status).toBe(403);
  });

  test('staff report request older than 1 day is rejected outright', async () => {
    const branch = await makeBranch();
    const { token } = await makeUser('staff', [branch._id.toString()]);

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .get('/api/reports/sales')
      .query({ branchId: branch._id.toString(), from: eightDaysAgo })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('staff report request for today succeeds', async () => {
    const branch = await makeBranch();
    const { token } = await makeUser('staff', [branch._id.toString()]);

    const res = await request(app)
      .get('/api/reports/sales')
      .query({ branchId: branch._id.toString() })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  test('staff cannot view the profit report at all', async () => {
    const branch = await makeBranch();
    const { token } = await makeUser('staff', [branch._id.toString()]);

    const res = await request(app).get('/api/reports/profit').query({ branchId: branch._id.toString() }).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
