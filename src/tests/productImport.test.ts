import request from 'supertest';
import { createApp } from '../app';
import { makeUser } from './fixtures';
import { Product } from '../models/Product';
import { ProductSku } from '../models/ProductSku';
import { ProductVariant } from '../models/ProductVariant';
import { parsePowers } from '../services/productImportService';

const app = createApp();

describe('parsePowers', () => {
  test('single, list, range and default step', () => {
    expect(parsePowers('-1.25')).toEqual([-1.25]);
    expect(parsePowers('0, -0.5, -1')).toEqual([0, -0.5, -1]);
    expect(parsePowers('0 ถึง -1 ขั้นละ 0.5')).toEqual([0, -0.5, -1]);
    expect(parsePowers('0~-0.5')).toEqual([0, -0.25, -0.5]);
    expect(parsePowers('0:-1:0.5, -3')).toEqual([0, -0.5, -1, -3]);
    expect(parsePowers('-')).toBeUndefined();
    expect(parsePowers('abc')).toBeNull();
  });
});

describe('Excel product import', () => {
  test('imports a grouped sheet (blank name = same product), then re-import only adds new rows', async () => {
    const { token } = await makeUser('admin');
    const tag = `${Date.now()}`.slice(-6);
    const name850 = `Mini Olivia 850 ${tag}`;
    const name800 = `Mini Olivia 800 ${tag}`;
    const colors = ['Brown', 'Light Brown', 'Gray', 'Green', 'Black', 'Blue'];
    const rows = [
      ...colors.map((color, i) => ({ row: i + 2, name: i === 0 ? name850 : '-', color, price: '฿ 109.00', unit: 'คู่', powers: '0 ถึง -1 ขั้นละ 0.5', brand: `Olivia ${tag}` })),
      ...colors.map((color, i) => ({ row: i + 8, name: i === 0 ? name800 : '', color, price: 109, unit: 'คู่' })),
    ];

    const preview = await request(app).post('/api/products/import/preview').set('Authorization', `Bearer ${token}`).send({ rows });
    expect(preview.status).toBe(200);
    expect(preview.body.errors).toEqual([]);
    expect(preview.body.newProductCount).toBe(2);
    expect(preview.body.newSkuCount).toBe(6 * 3 + 6);
    expect(preview.body.newBrands).toEqual([`Olivia ${tag}`]);

    const res = await request(app).post('/api/products/import').set('Authorization', `Bearer ${token}`).send({ rows });
    expect(res.status).toBe(201);
    expect(res.body.skuCount).toBe(24);

    const p850 = await Product.findOne({ name: name850 });
    expect(p850?.unitOfMeasure).toBe('pair');
    expect(p850?.defaultPriceRegular).toBe(10900);
    expect(await ProductVariant.countDocuments({ productId: p850!._id })).toBe(6);
    const skus = await ProductSku.find({ productId: p850!._id });
    expect(skus).toHaveLength(18);
    expect(skus.every((s) => s.priceRegular === 10900)).toBe(true);

    // Re-import with one extra color: existing SKUs are skipped, only the new color is added.
    const again = [...rows, { row: 20, name: name800, color: 'Pink', price: '119', unit: 'คู่' }];
    const res2 = await request(app).post('/api/products/import').set('Authorization', `Bearer ${token}`).send({ rows: again });
    expect(res2.status).toBe(201);
    expect(res2.body.skuCount).toBe(1);
    expect(res2.body.skippedCount).toBe(24);
    const pink = await ProductSku.findOne({ priceRegular: 11900, productId: (await Product.findOne({ name: name800 }))!._id });
    expect(pink).not.toBeNull();
  });

  test('power price applies to non-zero powers only, like the add form', async () => {
    const { token } = await makeUser('admin');
    const name = `Power Price ${Date.now()}`;
    const rows = [
      { row: 2, name, shortCode: `PP${Date.now()}`.slice(0, 10), color: 'Brown', price: '109', powerPrice: '129', powers: '0, -0.50, -1.00' },
      { row: 3, name: '-', color: 'Gray', powers: '0, -0.50' },
    ];
    const res = await request(app).post('/api/products/import').set('Authorization', `Bearer ${token}`).send({ rows });
    expect(res.status).toBe(201);
    const product = await Product.findOne({ name });
    expect(product?.defaultPriceRegular).toBe(10900);
    expect(product?.defaultPowerPriceRegular).toBe(12900);
    const skus = await ProductSku.find({ productId: product!._id });
    expect(skus).toHaveLength(5);
    for (const s of skus) expect(s.priceRegular).toBe(s.power ? 12900 : 10900);
  });

  test('bad cells are reported per row and nothing is written', async () => {
    const { token } = await makeUser('admin');
    const name = `Broken ${Date.now()}`;
    const rows = [
      { row: 2, name, color: 'Brown', price: 'abc' },
      { row: 3, name, color: 'Gray', powers: '??' },
      { row: 4, name, color: 'Gray', unit: 'ลัง' },
    ];
    const res = await request(app).post('/api/products/import').set('Authorization', `Bearer ${token}`).send({ rows });
    expect(res.status).toBe(400);
    expect(res.body.error.details.errors.map((e: { row: number }) => e.row)).toEqual([2, 3, 4]);
    expect(await Product.findOne({ name })).toBeNull();
  });
});
