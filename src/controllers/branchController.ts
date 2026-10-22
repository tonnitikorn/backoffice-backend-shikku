import { z } from 'zod';
import { Branch } from '../models/Branch';
import { User } from '../models/User';
import { Inventory } from '../models/Inventory';
import { InventoryTransaction } from '../models/InventoryTransaction';
import { Sale } from '../models/Sale';
import { Order } from '../models/Order';
import { Purchase } from '../models/Purchase';
import { StockTransfer } from '../models/StockTransfer';
import { ShiftSession } from '../models/ShiftSession';
import { ShiftDefinition } from '../models/ShiftDefinition';
import { Expense } from '../models/Expense';
import { buildCrudRouter } from '../utils/crudFactory';
import { findBlockingReference } from '../services/referenceGuard';

const createSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  address: z.string().optional(),
  phone: z.string().optional(),
  active: z.boolean().optional(),
  isDefaultOnlineBranch: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

export default buildCrudRouter({
  model: Branch,
  createSchema,
  updateSchema,
  writeRoles: ['admin'],
  searchFields: ['name', 'code'],
  sort: { code: 1 },
  deleteGuard: (branch) =>
    findBlockingReference('สาขา', [
      [Sale, { branchId: branch._id }, 'บิลขาย'],
      [Order, { branchId: branch._id }, 'ออเดอร์ออนไลน์'],
      [Purchase, { branchId: branch._id }, 'ใบรับสินค้า'],
      [StockTransfer, { $or: [{ fromBranchId: branch._id }, { toBranchId: branch._id }] }, 'การโอนสต๊อก'],
      [InventoryTransaction, { branchId: branch._id }, 'ประวัติสต๊อก'],
      [Inventory, { branchId: branch._id, qtyOnHand: { $gt: 0 } }, 'สต๊อกคงเหลือ'],
      [ShiftSession, { branchId: branch._id }, 'กะการขาย'],
      [ShiftDefinition, { branchId: branch._id }, 'รูปแบบกะ'],
      [Expense, { branchId: branch._id }, 'ค่าใช้จ่าย'],
      [User, { branchIds: branch._id }, 'ผู้ใช้งาน'],
    ]),
});
