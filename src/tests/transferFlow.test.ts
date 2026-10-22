import { makeBranch, makeUser, makeSkuWithStock } from './fixtures';
import * as transferService from '../services/transferService';
import { StockTransferItem } from '../models/StockTransferItem';
import { Inventory } from '../models/Inventory';

describe('Stock transfer 3-state flow (spec B7)', () => {
  test('send -> in_transit -> receive moves stock only on receipt', async () => {
    const branchA = await makeBranch();
    const branchB = await makeBranch();
    const { user: admin } = await makeUser('admin');
    const { sku } = await makeSkuWithStock(branchA._id.toString(), { qty: 10 });

    const transfer = await transferService.createTransfer({
      fromBranchId: branchA._id.toString(),
      toBranchId: branchB._id.toString(),
      items: [{ skuId: sku._id.toString(), qty: 4 }],
      sentBy: admin._id.toString(),
    });

    let invA = await Inventory.findOne({ branchId: branchA._id, skuId: sku._id });
    let invB = await Inventory.findOne({ branchId: branchB._id, skuId: sku._id });
    expect(invA?.qtyOnHand).toBe(6); // cut immediately from source
    expect(invB?.qtyOnHand ?? 0).toBe(0); // not yet arrived

    await transferService.markInTransit(transfer._id.toString(), 'Grab Express', admin._id.toString());

    const items = await StockTransferItem.find({ transferId: transfer._id });
    const received = await transferService.receiveTransfer(transfer._id.toString(), {
      items: [{ itemId: items[0]._id.toString(), qtyReceived: 4 }],
      userId: admin._id.toString(),
    });
    expect(received.status).toBe('received');

    invA = await Inventory.findOne({ branchId: branchA._id, skuId: sku._id });
    invB = await Inventory.findOne({ branchId: branchB._id, skuId: sku._id });
    expect(invA?.qtyOnHand).toBe(6);
    expect(invB?.qtyOnHand).toBe(4);
  });

  test('cancelling before receipt returns stock to the source branch', async () => {
    const branchA = await makeBranch();
    const branchB = await makeBranch();
    const { user: admin } = await makeUser('admin');
    const { sku } = await makeSkuWithStock(branchA._id.toString(), { qty: 10 });

    const transfer = await transferService.createTransfer({
      fromBranchId: branchA._id.toString(),
      toBranchId: branchB._id.toString(),
      items: [{ skuId: sku._id.toString(), qty: 3 }],
      sentBy: admin._id.toString(),
    });

    await transferService.cancelTransfer(transfer._id.toString(), admin._id.toString(), 'sent by mistake');

    const invA = await Inventory.findOne({ branchId: branchA._id, skuId: sku._id });
    expect(invA?.qtyOnHand).toBe(10);
  });

  test('partial receipt without a reason is rejected', async () => {
    const branchA = await makeBranch();
    const branchB = await makeBranch();
    const { user: admin } = await makeUser('admin');
    const { sku } = await makeSkuWithStock(branchA._id.toString(), { qty: 10 });

    const transfer = await transferService.createTransfer({
      fromBranchId: branchA._id.toString(),
      toBranchId: branchB._id.toString(),
      items: [{ skuId: sku._id.toString(), qty: 5 }],
      sentBy: admin._id.toString(),
    });
    const items = await StockTransferItem.find({ transferId: transfer._id });

    await expect(
      transferService.receiveTransfer(transfer._id.toString(), {
        items: [{ itemId: items[0]._id.toString(), qtyReceived: 3 }],
        userId: admin._id.toString(),
      }),
    ).rejects.toThrow(/reason is required/);
  });
});
