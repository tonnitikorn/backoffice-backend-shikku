import { Branch } from '../models/Branch';
import { User } from '../models/User';
import { Product } from '../models/Product';
import { ProductSku } from '../models/ProductSku';
import { Inventory } from '../models/Inventory';
import { hashPassword, signAccessToken } from '../services/authService';
import { Role } from '../config/constants';

let counter = 0;
function unique(prefix: string) {
  counter += 1;
  return `${prefix}${Date.now()}${counter}`;
}

export async function makeBranch(overrides: Partial<{ code: string; name: string }> = {}) {
  return Branch.create({
    code: overrides.code ?? unique('BR'),
    name: overrides.name ?? 'Test Branch',
  });
}

export async function makeUser(role: Role, branchIds: string[] = []) {
  const passwordHash = await hashPassword('Password123!');
  const user = await User.create({
    name: `Test ${role}`,
    email: `${unique(role)}@test.local`,
    passwordHash,
    role,
    branchIds,
  });
  const token = signAccessToken(user);
  return { user, token };
}

export async function makeSkuWithStock(branchId: string, opts: { qty?: number; cost?: number; price?: number } = {}) {
  const product = await Product.create({
    name: 'Test Lens',
    shortCode: unique('TL'),
    type: 'contact_lens',
    defaultPriceRegular: opts.price ?? 50000,
    defaultCost: opts.cost ?? 20000,
  });
  const sku = await ProductSku.create({
    productId: product._id,
    skuCode: unique('SKU'),
    barcode: unique('BC'),
    priceRegular: opts.price ?? 50000,
    cost: opts.cost ?? 20000,
    minStockLevel: 0,
  });
  await Inventory.create({ branchId, skuId: sku._id, qtyOnHand: opts.qty ?? 10 });
  return { product, sku };
}
