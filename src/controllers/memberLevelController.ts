import { z } from 'zod';
import { MemberLevel } from '../models/MemberLevel';
import { Customer } from '../models/Customer';
import { Promotion } from '../models/Promotion';
import { buildCrudRouter } from '../utils/crudFactory';
import { findBlockingReference } from '../services/referenceGuard';

const createSchema = z.object({
  name: z.string().min(1),
  thresholdSpend: z.number().min(0).optional(),
  benefitsDescription: z.string().optional(),
  active: z.boolean().optional(),
});

export default buildCrudRouter({
  model: MemberLevel,
  createSchema,
  updateSchema: createSchema.partial(),
  writeRoles: ['admin'],
  searchFields: ['name'],
  sort: { thresholdSpend: 1 },
  deleteGuard: (level) =>
    findBlockingReference('ระดับสมาชิก', [
      [Customer, { memberLevelId: level._id }, 'ข้อมูลลูกค้า'],
      [Promotion, { scopeMemberLevelIds: level._id }, 'โปรโมชั่น'],
    ]),
});
