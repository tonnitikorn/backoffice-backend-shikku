import request from 'supertest';
import { createApp } from '../app';
import { makeBranch, makeUser, makeSkuWithStock } from './fixtures';
import { Branch } from '../models/Branch';
import { Supplier } from '../models/Supplier';
import { Purchase } from '../models/Purchase';
import { PurchaseItem } from '../models/PurchaseItem';
import { Product } from '../models/Product';
import { ProductSku } from '../models/ProductSku';

const app = createApp();

describe('Reference-data CRUD (edit / delete)', () => {
  test('admin can edit and delete an unused branch', async () => {
    const { token } = await makeUser('admin');
    const branch = await makeBranch();

    const patch = await request(app)
      .patch(`/api/branches/${branch._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed', phone: '0812345678' });
    expect(patch.status).toBe(200);
    expect(patch.body.item.name).toBe('Renamed');

    const del = await request(app).delete(`/api/branches/${branch._id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);
    expect(await Branch.findById(branch._id)).toBeNull();
  });

  test('deleting a branch that still has stock is blocked with 409', async () => {
    const { token } = await makeUser('admin');
    const branch = await makeBranch();
    await makeSkuWithStock(branch._id.toString(), { qty: 3 });

    const del = await request(app).delete(`/api/branches/${branch._id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(409);
    expect(await Branch.findById(branch._id)).not.toBeNull();
  });

  test('non-admins cannot delete branches', async () => {
    const branch = await makeBranch();
    const { token } = await makeUser('branch_manager', [branch._id.toString()]);
    const del = await request(app).delete(`/api/branches/${branch._id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(403);
  });

  test('duplicate branch code returns 409 instead of a 500', async () => {
    const { token } = await makeUser('admin');
    const branch = await makeBranch();
    const res = await request(app)
      .post('/api/branches')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: branch.code, name: 'Dup' });
    expect(res.status).toBe(409);
  });

  test('supplier referenced by a purchase cannot be deleted', async () => {
    const { user, token } = await makeUser('admin');
    const branch = await makeBranch();
    const supplier = await Supplier.create({ name: 'Lens Co' });
    await Purchase.create({ supplierId: supplier._id, branchId: branch._id, purchaseDate: new Date(), createdBy: user._id });

    const del = await request(app).delete(`/api/suppliers/${supplier._id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(409);
  });
});

describe('Expenses', () => {
  test('create records the caller and list filters by branch', async () => {
    const branchA = await makeBranch();
    const branchB = await makeBranch();
    const { user, token } = await makeUser('branch_manager', [branchA._id.toString()]);

    const create = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: branchA._id.toString(), date: new Date().toISOString(), category: 'rent', description: 'Rent', amount: 100000 });
    expect(create.status).toBe(201);
    expect(create.body.item.recordedBy).toBe(user._id.toString());

    const forbidden = await request(app)
      .post('/api/expenses')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: branchB._id.toString(), date: new Date().toISOString(), category: 'rent', description: 'X', amount: 1 });
    expect(forbidden.status).toBe(403);

    const listB = await request(app).get('/api/expenses').query({ branchId: branchB._id.toString() }).set('Authorization', `Bearer ${token}`);
    expect(listB.body.items).toHaveLength(0);

    const del = await request(app).delete(`/api/expenses/${create.body.item._id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);
  });
});

describe('Products', () => {
  test('a product whose SKUs have stock cannot be deleted; an empty one can', async () => {
    const { token } = await makeUser('admin');
    const branch = await makeBranch();
    const { product: stocked } = await makeSkuWithStock(branch._id.toString(), { qty: 5 });

    const blocked = await request(app).delete(`/api/products/${stocked._id}`).set('Authorization', `Bearer ${token}`);
    expect(blocked.status).toBe(409);

    const { product: empty, sku } = await makeSkuWithStock(branch._id.toString(), { qty: 0 });
    const ok = await request(app).delete(`/api/products/${empty._id}`).set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(204);
    expect(await Product.findById(empty._id)).toBeNull();
    expect(await ProductSku.findById(sku._id)).toBeNull();
  });

  test('SKU search tolerates regex metacharacters', async () => {
    const branch = await makeBranch();
    const { token } = await makeUser('staff', [branch._id.toString()]);
    const res = await request(app)
      .get('/api/products/skus/search')
      .query({ branchId: branch._id.toString(), q: '(+' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('Purchase drafts', () => {
  test('draft can be edited and deleted; confirmed cannot be deleted', async () => {
    const branch = await makeBranch();
    const { token } = await makeUser('admin');
    const supplier = await Supplier.create({ name: 'Draft Supplier' });
    const { sku } = await makeSkuWithStock(branch._id.toString(), { qty: 0 });

    const create = await request(app)
      .post('/api/purchases')
      .set('Authorization', `Bearer ${token}`)
      .send({
        supplierId: supplier._id.toString(),
        branchId: branch._id.toString(),
        purchaseDate: new Date().toISOString(),
        items: [{ skuId: sku._id.toString(), qty: 2, unitCost: 1000 }],
      });
    expect(create.status).toBe(201);
    const id = create.body.item._id;

    const edit = await request(app)
      .patch(`/api/purchases/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ skuId: sku._id.toString(), qty: 5, unitCost: 1000 }], shippingCost: 500 });
    expect(edit.status).toBe(200);
    expect(edit.body.purchase.totalCost).toBe(5500);
    expect(await PurchaseItem.countDocuments({ purchaseId: id })).toBe(1);

    const del = await request(app).delete(`/api/purchases/${id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);
    expect(await PurchaseItem.countDocuments({ purchaseId: id })).toBe(0);

    const second = await request(app)
      .post('/api/purchases')
      .set('Authorization', `Bearer ${token}`)
      .send({
        supplierId: supplier._id.toString(),
        branchId: branch._id.toString(),
        purchaseDate: new Date().toISOString(),
        items: [{ skuId: sku._id.toString(), qty: 1, unitCost: 1000 }],
      });
    await request(app).post(`/api/purchases/${second.body.item._id}/confirm`).set('Authorization', `Bearer ${token}`);
    const delConfirmed = await request(app).delete(`/api/purchases/${second.body.item._id}`).set('Authorization', `Bearer ${token}`);
    expect(delConfirmed.status).toBe(409);
  });
});

describe('Users', () => {
  test('admin cannot delete themselves; can delete an unused user', async () => {
    const { user: admin, token } = await makeUser('admin');
    const self = await request(app).delete(`/api/users/${admin._id}`).set('Authorization', `Bearer ${token}`);
    expect(self.status).toBe(400);

    const { user: other } = await makeUser('staff');
    const del = await request(app).delete(`/api/users/${other._id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);
  });

  test('user list returns plain branch id strings', async () => {
    const branch = await makeBranch();
    const { token } = await makeUser('admin');
    await makeUser('staff', [branch._id.toString()]);
    const res = await request(app).get('/api/users').set('Authorization', `Bearer ${token}`);
    const staffRow = res.body.items.find((u: { branchIds: string[] }) => u.branchIds.includes(branch._id.toString()));
    expect(staffRow).toBeDefined();
  });
});

describe('Bulk product creation (many models × colors × powers)', () => {
  const colors = [{ name: 'Brown' }, { name: 'Light Brown' }, { name: 'Gray' }, { name: 'Green' }, { name: 'Black' }, { name: 'Blue' }];

  test('creates every model/color/power combination with unique SKU codes', async () => {
    const { token } = await makeUser('admin');
    const tag = `${Date.now()}`.slice(-6);
    const body = {
      models: [
        { name: 'Mini Olivia 850', shortCode: `MO850${tag}` },
        { name: 'Mini Olivia 800', shortCode: `MO800${tag}` },
      ],
      common: { type: 'contact_lens', unitOfMeasure: 'pair', defaultPriceRegular: 10900, defaultCost: 5000 },
      colors,
      ranges: [{ from: 0, to: -1, step: 0.25 }], // 0.00, -0.25 … -1.00 = 5 powers
    };

    const preview = await request(app).post('/api/products/bulk/preview').set('Authorization', `Bearer ${token}`).send(body);
    expect(preview.status).toBe(200);
    expect(preview.body.totalSkus).toBe(2 * 6 * 5);
    expect(preview.body.duplicates).toHaveLength(0);

    const res = await request(app).post('/api/products/bulk').set('Authorization', `Bearer ${token}`).send(body);
    expect(res.status).toBe(201);
    expect(res.body.skuCount).toBe(60);

    const skus = await ProductSku.find({ productId: { $in: res.body.items.map((p: { _id: string }) => p._id) } });
    expect(skus).toHaveLength(60);
    expect(new Set(skus.map((s) => s.skuCode)).size).toBe(60);
    expect(skus.every((s) => s.priceRegular === 10900 && s.variantId)).toBe(true);

    // Re-running the same batch must be rejected as a whole, not half-applied.
    const again = await request(app).post('/api/products/bulk').set('Authorization', `Bearer ${token}`).send(body);
    expect(again.status).toBe(409);
  });

  test('can add more colors to an existing product later', async () => {
    const { token } = await makeUser('admin');
    const tag = `${Date.now()}`.slice(-6);
    const created = await request(app)
      .post('/api/products/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ models: [{ name: 'Olivia', shortCode: `OL${tag}` }], common: { type: 'contact_lens' }, colors: [{ name: 'Brown' }], ranges: [{ from: 0, to: 0, step: 0.25 }] });
    const productId = created.body.items[0]._id;

    const add = await request(app)
      .post(`/api/products/${productId}/colors`)
      .set('Authorization', `Bearer ${token}`)
      .send({ colors: [{ name: 'Gray' }, { name: 'Blue' }], ranges: [{ from: 0, to: 0, step: 0.25 }] });
    expect(add.status).toBe(201);
    expect(await ProductSku.countDocuments({ productId })).toBe(3);

    const dupColor = await request(app)
      .post(`/api/products/${productId}/colors`)
      .set('Authorization', `Bearer ${token}`)
      .send({ colors: [{ name: 'brown' }] });
    expect(dupColor.status).toBe(409);
  });
});

describe('Bulk create with explicit powers and opening stock', () => {
  test('qty per power × color lands in the branch through the ledger', async () => {
    const { Inventory } = await import('../models/Inventory');
    const { InventoryTransaction } = await import('../models/InventoryTransaction');
    const { token } = await makeUser('admin');
    const branch = await makeBranch();
    const tag = `${Date.now()}`.slice(-6);

    const res = await request(app)
      .post('/api/products/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({
        models: [{ name: `Stocked ${tag}`, shortCode: `ST${tag}` }],
        common: { type: 'contact_lens', defaultPriceRegular: 10900 },
        colors: [{ name: 'Brown' }, { name: 'Gray' }],
        powers: [0, -1.25, -3],
        branchId: branch._id.toString(),
        stock: [
          { model: 0, color: 'Brown', power: -1.25, qty: 4 },
          { model: 0, color: 'Gray', power: 0, qty: 2 },
          { model: 0, color: 'Gray', power: -3, qty: 0 },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.skuCount).toBe(6);
    expect(res.body.stockQty).toBe(6);

    const productId = res.body.items[0]._id;
    const skus = await ProductSku.find({ productId });
    const brownVariant = await (await import('../models/ProductVariant')).ProductVariant.findOne({ productId, colorName: 'Brown' });
    const brown125 = skus.find((s) => s.power === -1.25 && s.variantId?.equals(brownVariant!._id));
    const inv = await Inventory.findOne({ branchId: branch._id, skuId: brown125!._id });
    expect(inv?.qtyOnHand).toBe(4);
    expect(await InventoryTransaction.countDocuments({ branchId: branch._id, skuId: { $in: skus.map((s) => s._id) } })).toBe(2);
  });

  test('opening stock without a branch is rejected and nothing is created', async () => {
    const { token } = await makeUser('admin');
    const name = `NoBranch ${Date.now()}`;
    const res = await request(app)
      .post('/api/products/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ models: [{ name, shortCode: `NB${Date.now()}`.slice(0, 10) }], common: { type: 'contact_lens' }, powers: [0], stock: [{ model: 0, color: null, power: 0, qty: 1 }] });
    expect(res.status).toBe(400);
    expect(await Product.findOne({ name })).toBeNull();
  });
});

describe('Separate price for plano (0.00) vs power SKUs', () => {
  test('bulk create prices 0.00 with the regular price and other powers with the power price; edit can re-apply', async () => {
    const { token } = await makeUser('admin');
    const tag = `${Date.now()}`.slice(-6);
    const res = await request(app)
      .post('/api/products/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({
        models: [{ name: `Priced ${tag}`, shortCode: `PR${tag}` }],
        common: { type: 'contact_lens', defaultPriceRegular: 10900, defaultPowerPriceRegular: 12900 },
        colors: [{ name: 'Brown' }],
        powers: [0, -0.5, -3],
      });
    expect(res.status).toBe(201);
    const productId = res.body.items[0]._id;
    const skus = await ProductSku.find({ productId });
    expect(skus.find((s) => s.power === 0)!.priceRegular).toBe(10900);
    expect(skus.filter((s) => s.power !== 0).every((s) => s.priceRegular === 12900)).toBe(true);

    const edit = await request(app)
      .patch(`/api/products/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ defaultPriceRegular: 9900, defaultPowerPriceRegular: 13900, applyPricesToSkus: true });
    expect(edit.status).toBe(200);
    expect(edit.body.updatedSkus).toBe(3);
    const after = await ProductSku.find({ productId });
    expect(after.find((s) => s.power === 0)!.priceRegular).toBe(9900);
    expect(after.find((s) => s.power === -3)!.priceRegular).toBe(13900);
  });
});

describe('Editing product prices updates SKU prices automatically', () => {
  test('SKUs on the old price follow the new price; individually priced SKUs are kept', async () => {
    const { token } = await makeUser('admin');
    const tag = `${Date.now()}`.slice(-6);
    const res = await request(app)
      .post('/api/products/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({
        models: [{ name: `AutoPrice ${tag}`, shortCode: `AP${tag}` }],
        common: { type: 'contact_lens', defaultPriceRegular: 10900 },
        colors: [{ name: 'Brown' }],
        powers: [0, -1, -2],
      });
    const productId = res.body.items[0]._id;
    const custom = await ProductSku.findOneAndUpdate({ productId, power: -2 }, { $set: { priceRegular: 15000 } }, { new: true });

    const edit = await request(app)
      .patch(`/api/products/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ defaultPriceRegular: 9900, defaultPowerPriceRegular: 12900 }); // no applyPricesToSkus flag
    expect(edit.status).toBe(200);
    expect(edit.body.updatedSkus).toBe(2);

    const skus = await ProductSku.find({ productId });
    expect(skus.find((s) => s.power === 0)!.priceRegular).toBe(9900);
    expect(skus.find((s) => s.power === -1)!.priceRegular).toBe(12900);
    expect(skus.find((s) => s._id.equals(custom!._id))!.priceRegular).toBe(15000);
  });
});
