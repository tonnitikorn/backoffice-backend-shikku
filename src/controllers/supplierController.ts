import { z } from 'zod';
import { Supplier } from '../models/Supplier';
import { Purchase } from '../models/Purchase';
import { buildCrudRouter } from '../utils/crudFactory';
import { findBlockingReference } from '../services/referenceGuard';

const createSchema = z.object({
  name: z.string().min(1),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  address: z.string().optional(),
  taxId: z.string().optional(),
  notes: z.string().optional(),
  active: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

export default buildCrudRouter({
  model: Supplier,
  createSchema,
  updateSchema,
  writeRoles: ['admin', 'branch_manager'],
  deleteRoles: ['admin'],
  searchFields: ['name', 'contactName', 'phone'],
  deleteGuard: (supplier) => findBlockingReference('Supplier', [[Purchase, { supplierId: supplier._id }, 'ใบรับสินค้า']]),
});
