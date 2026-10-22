import { Product } from '../models/Product';
import * as skuGen from '../services/skuGenerationService';
import { makeUser } from './fixtures';
import { Setting, SETTING_KEYS } from '../models/Setting';

describe('SKU generation (spec B5)', () => {
  test('preview reports correct count and flags existing duplicates', async () => {
    const { user: admin } = await makeUser('admin');
    const product = await Product.create({ name: 'Preview Lens', shortCode: 'PVW', type: 'contact_lens' });

    const first = await skuGen.generateSkus({
      productId: product._id.toString(),
      ranges: [{ from: -1, to: -2, step: 0.25 }],
      createdBy: admin._id.toString(),
    });
    expect(first.createdSkus).toHaveLength(5); // -1.00, -1.25, -1.50, -1.75, -2.00

    const preview = await skuGen.previewSkuGeneration({
      productId: product._id.toString(),
      ranges: [{ from: -1, to: -3, step: 0.25 }],
      createdBy: admin._id.toString(),
    });

    expect(preview.totalRequested).toBe(9); // -1.00 .. -3.00 step 0.25
    expect(preview.totalDuplicates).toBe(5);
    expect(preview.totalToCreate).toBe(4);
  });

  test('generation is rejected when it would exceed the per-run cap', async () => {
    const { user: admin } = await makeUser('admin');
    const product = await Product.create({ name: 'Capped Lens', shortCode: 'CAP', type: 'contact_lens' });
    await Setting.findOneAndUpdate({ key: SETTING_KEYS.skuGenerationCap }, { $set: { value: 3 } }, { upsert: true });

    await expect(
      skuGen.generateSkus({
        productId: product._id.toString(),
        ranges: [{ from: -1, to: -2, step: 0.25 }], // 5 values > cap of 3
        createdBy: admin._id.toString(),
      }),
    ).rejects.toThrow(/exceeds the per-run cap/);
  });
});
