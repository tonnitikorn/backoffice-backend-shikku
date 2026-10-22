import request from 'supertest';
import { createApp } from '../app';
import { makeBranch, makeUser, makeSkuWithStock } from './fixtures';
import { ProductVariant } from '../models/ProductVariant';
import { ProductSku } from '../models/ProductSku';
import { StockPhotoScan } from '../models/StockPhotoScan';
import * as scanService from '../services/stockPhotoScanService';
import { removeUploadedFile } from '../utils/imageUpload';

const app = createApp();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

describe('Stock from tray photo', () => {
  test('maps AI readings to SKUs, flags unknowns, and returns them ready to pre-fill the top-up form', async () => {
    const branch = await makeBranch();
    const branchId = branch._id.toString();
    const { user: manager } = await makeUser('branch_manager', [branchId]);
    const { product } = await makeSkuWithStock(branchId, { qty: 0 });
    const brown = await ProductVariant.create({ productId: product._id, colorName: 'Brown' });
    const sku = await ProductSku.create({ productId: product._id, variantId: brown._id, skuCode: `T-BRO-${Date.now()}`, barcode: `T-BRO-${Date.now()}`, power: -1.25, priceRegular: 10900, cost: 0, minStockLevel: 0 });

    const { rows, samples } = await scanService.matchToCatalog({
      rows: [
        { model: product.name.toUpperCase(), color: 'BROWN', power: -1.25, vials: 4, confidence: 'high', note: '' },
        { model: product.name, color: 'Gray', power: -1.25, vials: 2, confidence: 'low', note: 'ฝาเบลอ' },
        { model: product.name, color: 'Brown', power: -9, vials: 2, confidence: 'high', note: '' },
        { model: 'Unknown Lens', color: 'Brown', power: -1, vials: 2, confidence: 'high', note: '' },
      ],
      samples: [{ model: product.name, color: 'Brown', x: 0.1, y: 0.2, w: 0.05, h: 1.4 }],
    });
    expect(rows[0].skuId?.toString()).toBe(sku._id.toString());
    expect(rows[1].matchError).toMatch(/สี/);
    expect(rows[2].matchError).toMatch(/ค่าสายตา/);
    expect(rows[3].matchError).toMatch(/รุ่น/);
    expect(samples[0].variantId?.toString()).toBe(brown._id.toString());
    expect(samples[0].box.h).toBe(1); // clamped into the image

    const scan = await StockPhotoScan.create({ branchId, imageUrl: '/uploads/stock-scans/x.jpg', status: 'ready', rows, samples, createdBy: manager._id });
    const { token } = await makeUser('branch_manager', [branchId]);
    const got = await request(app).get(`/api/stock/photo-scans/${scan._id}`).set('Authorization', `Bearer ${token}`);
    expect(got.status).toBe(200);
    expect(got.body.item.rows[0]).toMatchObject({ productId: { name: product.name }, variantId: { colorName: 'Brown' }, skuId: { skuCode: sku.skuCode, power: -1.25 } });
    expect(got.body.item.samples[0].variantId).toMatchObject({ colorName: 'Brown', images: [] });

    const { token: otherToken } = await makeUser('branch_manager', [(await makeBranch())._id.toString()]);
    const other = await request(app).get(`/api/stock/photo-scans/${scan._id}`).set('Authorization', `Bearer ${otherToken}`);
    expect(other.status).toBe(403);
  });

  test('staff cannot scan; without an API key the photo waits for a result pasted back from the Claude app', async () => {
    const branch = await makeBranch();
    const branchId = branch._id.toString();
    const { user: manager, token: managerToken } = await makeUser('branch_manager', [branchId]);
    const { token: staffToken } = await makeUser('staff', [branchId]);
    const { product } = await makeSkuWithStock(branchId, { qty: 0 });
    const brown = await ProductVariant.create({ productId: product._id, colorName: 'Brown' });
    const sku = await ProductSku.create({ productId: product._id, variantId: brown._id, skuCode: `T-MAN-${Date.now()}`, barcode: `T-MAN-${Date.now()}`, power: -2, priceRegular: 10900, cost: 0, minStockLevel: 0 });

    const staff = await request(app).post('/api/stock/photo-scans').set('Authorization', `Bearer ${staffToken}`).field('branchId', branchId).attach('image', PNG, 'tray.png');
    expect(staff.status).toBe(403);

    const prompt = await request(app).get('/api/stock/photo-scans/prompt').set('Authorization', `Bearer ${managerToken}`);
    expect(prompt.status).toBe(200);
    expect(prompt.body.prompt).toContain(product.name);
    expect(prompt.body.prompt).toContain('"unreadable"');

    const config = await request(app).get('/api/stock/photo-scans/config').set('Authorization', `Bearer ${managerToken}`);
    let scanId: string;
    if (config.body.configured) {
      // A real key is set in .env.test; don't spend money in tests.
      scanId = (await StockPhotoScan.create({ branchId, imageUrl: '/uploads/stock-scans/x.jpg', status: 'awaiting', createdBy: manager._id }))._id.toString();
    } else {
      const res = await request(app).post('/api/stock/photo-scans').set('Authorization', `Bearer ${managerToken}`).field('branchId', branchId).attach('image', PNG, 'tray.png');
      expect(res.status).toBe(202);
      expect(res.body.item.status).toBe('awaiting');
      scanId = res.body.item._id;
    }

    const bad = await request(app).post(`/api/stock/photo-scans/${scanId}/result`).set('Authorization', `Bearer ${managerToken}`).send({ text: 'ขอโทษครับ อ่านไม่ออก' });
    expect(bad.status).toBe(400);

    const pasted = '```json\n' + JSON.stringify({ rows: [{ model: product.name, color: 'Brown', power: -2, vials: 6, confidence: 'high', note: '' }], samples: [], unreadable: 1 }) + '\n```';
    const { token: otherToken } = await makeUser('branch_manager', [(await makeBranch())._id.toString()]);
    const other = await request(app).post(`/api/stock/photo-scans/${scanId}/result`).set('Authorization', `Bearer ${otherToken}`).send({ text: pasted });
    expect(other.status).toBe(403);

    const ok = await request(app).post(`/api/stock/photo-scans/${scanId}/result`).set('Authorization', `Bearer ${managerToken}`).send({ text: pasted });
    expect(ok.status).toBe(200);
    expect(ok.body.item).toMatchObject({ status: 'ready', unreadable: 1, modelUsed: 'manual' });
    expect(ok.body.item.rows[0]).toMatchObject({ vials: 6, skuId: { skuCode: sku.skuCode } });

    const again = await request(app).post(`/api/stock/photo-scans/${scanId}/result`).set('Authorization', `Bearer ${managerToken}`).send({ text: pasted });
    expect(again.status).toBe(400);
    await removeUploadedFile(ok.body.item.imageUrl);
  });
});
