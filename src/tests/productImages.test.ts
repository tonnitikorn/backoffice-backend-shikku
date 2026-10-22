import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createApp } from '../app';
import { makeBranch, makeUser, makeSkuWithStock } from './fixtures';

const app = createApp();
// Smallest valid PNG (1x1 transparent pixel).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

describe('Product photos and POS catalog', () => {
  test('admin uploads/removes a product photo; POS catalog and options expose it with stock', async () => {
    const branch = await makeBranch();
    const { token: adminToken } = await makeUser('admin');
    const { token: staffToken } = await makeUser('staff', [branch._id.toString()]);
    const { product, sku } = await makeSkuWithStock(branch._id.toString(), { qty: 7, price: 9900 });

    const denied = await request(app).post(`/api/products/${product._id}/images`).set('Authorization', `Bearer ${staffToken}`).attach('image', PNG, 'x.png');
    expect(denied.status).toBe(403);

    const notImage = await request(app)
      .post(`/api/products/${product._id}/images`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('image', Buffer.from('hello'), { filename: 'x.txt', contentType: 'text/plain' });
    expect(notImage.status).toBe(400);

    const up = await request(app).post(`/api/products/${product._id}/images`).set('Authorization', `Bearer ${adminToken}`).attach('image', PNG, 'lens.png');
    expect(up.status).toBe(201);
    const url: string = up.body.url;
    expect(url).toMatch(/^\/uploads\/products\/.+\.png$/);
    const file = path.resolve(process.cwd(), url.slice(1));
    expect(fs.existsSync(file)).toBe(true);

    const served = await request(app).get(url);
    expect(served.status).toBe(200);
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');

    const catalog = await request(app).get('/api/products/pos/catalog').query({ branchId: branch._id.toString() }).set('Authorization', `Bearer ${staffToken}`);
    const tile = catalog.body.items.find((i: { _id: string }) => i._id === product._id.toString());
    expect(tile).toMatchObject({ name: product.name, image: url, qtyOnHand: 7, skuCount: 1, singleSkuId: sku._id.toString(), priceMin: 9900 });

    const options = await request(app).get(`/api/products/${product._id}/pos-options`).query({ branchId: branch._id.toString() }).set('Authorization', `Bearer ${staffToken}`);
    expect(options.body.skus[0]).toMatchObject({ _id: sku._id.toString(), qtyOnHand: 7 });
    expect(options.body.skus[0].cost).toBeUndefined();

    const del = await request(app).delete(`/api/products/${product._id}/images`).set('Authorization', `Bearer ${adminToken}`).send({ url });
    expect(del.status).toBe(200);
    expect(del.body.item.images).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });
});
