import { z } from 'zod';
import { Brand } from '../models/Brand';
import { Product } from '../models/Product';
import { buildCrudRouter } from '../utils/crudFactory';
import { findBlockingReference } from '../services/referenceGuard';

const createSchema = z.object({
  name: z.string().min(1),
  active: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

export default buildCrudRouter({
  model: Brand,
  createSchema,
  updateSchema,
  writeRoles: ['admin'],
  searchFields: ['name'],
  sort: { name: 1 },
  deleteGuard: (brand) => findBlockingReference('แบรนด์', [[Product, { brandId: brand._id }, 'สินค้า']]),
});
