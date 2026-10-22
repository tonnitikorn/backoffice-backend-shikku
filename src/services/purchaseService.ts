import { Types } from 'mongoose';
import { Purchase, IPurchase } from '../models/Purchase';
import { PurchaseItem } from '../models/PurchaseItem';
import { ProductSku } from '../models/ProductSku';
import { withTransaction } from '../config/db';
import { moveStock } from './inventoryService';
import { recordAudit } from './auditService';
import { ApiError } from '../utils/ApiError';

export interface PurchaseItemInput {
  skuId: string;
  qty: number;
  unitCost: number;
  lot?: string;
  expiryDate?: string;
}

export async function createPurchase(input: {
  supplierId: string;
  branchId: string;
  invoiceNo?: string;
  purchaseDate: string;
  discountTotal?: number;
  vat?: number;
  shippingCost?: number;
  items: PurchaseItemInput[];
  createdBy: string;
}) {
  if (input.items.length === 0) throw ApiError.badRequest('Purchase must have at least one item');

  const subtotal = input.items.reduce((sum, i) => sum + i.unitCost * i.qty, 0);
  const discountTotal = input.discountTotal ?? 0;
  const vat = input.vat ?? 0;
  const shippingCost = input.shippingCost ?? 0;

  const purchase = await Purchase.create({
    supplierId: input.supplierId,
    branchId: input.branchId,
    invoiceNo: input.invoiceNo,
    purchaseDate: new Date(input.purchaseDate),
    status: 'draft',
    subtotal,
    discountTotal,
    vat,
    shippingCost,
    totalCost: subtotal - discountTotal + shippingCost + vat,
    createdBy: input.createdBy,
  });

  const items = await PurchaseItem.insertMany(
    input.items.map((i) => ({
      purchaseId: purchase._id,
      skuId: i.skuId,
      qty: i.qty,
      unitCost: i.unitCost,
      lot: i.lot,
      expiryDate: i.expiryDate ? new Date(i.expiryDate) : undefined,
    })),
  );

  return { purchase, items };
}

/**
 * Confirms a draft purchase: distributes the bill-level discount and
 * shipping cost proportionally across items by line value (spec B13, item
 * 9), writes one purchase_in ledger entry per item inside a single DB
 * transaction, and updates each SKU's running cost to the newly-allocated
 * unit cost. Draft edits after this point require the admin-only
 * adjustment endpoint (spec item 9).
 */
export async function confirmPurchase(purchaseId: string, confirmedBy: string) {
  const purchase = await Purchase.findById(purchaseId);
  if (!purchase) throw ApiError.notFound('Purchase not found');
  if (purchase.status === 'confirmed') throw ApiError.conflict('Purchase already confirmed');

  const items = await PurchaseItem.find({ purchaseId: purchase._id });
  if (items.length === 0) throw ApiError.badRequest('Purchase has no items');

  const subtotal = purchase.subtotal || 1; // guard against div by zero

  await withTransaction(async (session) => {
    for (const item of items) {
      const lineValue = item.unitCost * item.qty;
      const share = lineValue / subtotal;
      const allocatedDiscount = Math.round(purchase.discountTotal * share);
      const allocatedShipping = Math.round(purchase.shippingCost * share);
      const finalUnitCost = Math.round((lineValue - allocatedDiscount + allocatedShipping) / item.qty);

      item.allocatedDiscount = allocatedDiscount;
      item.allocatedShipping = allocatedShipping;
      item.finalUnitCost = finalUnitCost;
      await item.save({ session });

      await moveStock({
        branchId: purchase.branchId,
        skuId: item.skuId,
        type: 'purchase_in',
        qty: item.qty,
        lot: item.lot,
        expiryDate: item.expiryDate,
        refType: 'Purchase',
        refId: purchase._id,
        performedBy: confirmedBy,
        session,
      });

      await ProductSku.findByIdAndUpdate(item.skuId, { $set: { cost: finalUnitCost } }, { session });
    }

    purchase.status = 'confirmed';
    purchase.confirmedBy = new Types.ObjectId(confirmedBy);
    purchase.confirmedAt = new Date();
    await purchase.save({ session });

    await recordAudit(
      {
        userId: confirmedBy,
        branchId: purchase.branchId,
        action: 'purchase.confirm',
        entityType: 'Purchase',
        entityId: purchase._id.toString(),
        after: { itemCount: items.length, totalCost: purchase.totalCost },
      },
      session,
    );
  });

  return purchase;
}

export async function getPurchase(purchaseId: string): Promise<{ purchase: IPurchase; items: unknown[] }> {
  const purchase = await Purchase.findById(purchaseId).populate('supplierId branchId createdBy confirmedBy');
  if (!purchase) throw ApiError.notFound('Purchase not found');
  const items = await PurchaseItem.find({ purchaseId }).populate('skuId');
  return { purchase, items };
}

/**
 * Replaces a draft purchase's header and item lines. Confirmed purchases
 * are immutable here — they go through the admin-only item adjustment
 * endpoint instead so the stock ledger stays consistent.
 */
export async function updateDraftPurchase(
  purchaseId: string,
  input: {
    supplierId?: string;
    invoiceNo?: string;
    purchaseDate?: string;
    discountTotal?: number;
    vat?: number;
    shippingCost?: number;
    items?: PurchaseItemInput[];
  },
  updatedBy: string,
) {
  const purchase = await Purchase.findById(purchaseId);
  if (!purchase) throw ApiError.notFound('Purchase not found');
  if (purchase.status !== 'draft') throw ApiError.conflict('แก้ไขได้เฉพาะใบรับสินค้าที่ยังเป็นร่าง');
  if (input.items && input.items.length === 0) throw ApiError.badRequest('Purchase must have at least one item');

  const before = purchase.toObject();

  if (input.supplierId !== undefined) purchase.supplierId = new Types.ObjectId(input.supplierId);
  if (input.invoiceNo !== undefined) purchase.invoiceNo = input.invoiceNo;
  if (input.purchaseDate !== undefined) purchase.purchaseDate = new Date(input.purchaseDate);
  if (input.discountTotal !== undefined) purchase.discountTotal = input.discountTotal;
  if (input.vat !== undefined) purchase.vat = input.vat;
  if (input.shippingCost !== undefined) purchase.shippingCost = input.shippingCost;

  await withTransaction(async (session) => {
    if (input.items) {
      await PurchaseItem.deleteMany({ purchaseId: purchase._id }, { session });
      await PurchaseItem.insertMany(
        input.items.map((i) => ({
          purchaseId: purchase._id,
          skuId: i.skuId,
          qty: i.qty,
          unitCost: i.unitCost,
          lot: i.lot,
          expiryDate: i.expiryDate ? new Date(i.expiryDate) : undefined,
        })),
        { session },
      );
      purchase.subtotal = input.items.reduce((sum, i) => sum + i.unitCost * i.qty, 0);
    }
    purchase.totalCost = purchase.subtotal - purchase.discountTotal + purchase.shippingCost + purchase.vat;
    await purchase.save({ session });

    await recordAudit(
      {
        userId: updatedBy,
        branchId: purchase.branchId,
        action: 'purchase.update_draft',
        entityType: 'Purchase',
        entityId: purchase._id.toString(),
        before,
        after: purchase.toObject(),
      },
      session,
    );
  });

  return getPurchase(purchaseId);
}

export async function deleteDraftPurchase(purchaseId: string, deletedBy: string) {
  const purchase = await Purchase.findById(purchaseId);
  if (!purchase) throw ApiError.notFound('Purchase not found');
  if (purchase.status !== 'draft') throw ApiError.conflict('ลบได้เฉพาะใบรับสินค้าที่ยังเป็นร่าง');

  await withTransaction(async (session) => {
    await PurchaseItem.deleteMany({ purchaseId: purchase._id }, { session });
    await purchase.deleteOne({ session });
    await recordAudit(
      {
        userId: deletedBy,
        branchId: purchase.branchId,
        action: 'purchase.delete_draft',
        entityType: 'Purchase',
        entityId: purchase._id.toString(),
        before: purchase.toObject(),
      },
      session,
    );
  });
}
