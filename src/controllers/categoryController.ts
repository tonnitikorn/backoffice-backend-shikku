import { z } from 'zod';
import { Category } from '../models/Category';
import { Product } from '../models/Product';
import { PRODUCT_TYPES } from '../config/constants';
import { buildCrudRouter } from '../utils/crudFactory';
import { findBlockingReference } from '../services/referenceGuard';

const createSchema = z.object({
  name: z.string().min(1),
  appliesTo: z.enum(PRODUCT_TYPES),
  active: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

export default buildCrudRouter({
  model: Category,
  createSchema,
  updateSchema,
  writeRoles: ['admin'],
  searchFields: ['name'],
  sort: { name: 1 },
  deleteGuard: (category) => findBlockingReference('หมวดหมู่', [[Product, { categoryId: category._id }, 'สินค้า']]),
});
