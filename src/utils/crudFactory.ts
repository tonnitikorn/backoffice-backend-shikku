import { Request, Router } from 'express';
import { Model } from 'mongoose';
import { ZodTypeAny } from 'zod';
import { asyncHandler } from './asyncHandler';
import { validateBody } from './validate';
import { ApiError } from './ApiError';
import { requireAuth, requireActiveUser, requireRole } from '../middleware/auth';
import { Role } from '../config/constants';
import { recordAudit } from '../services/auditService';

/**
 * Simple CRUD router for reference-data collections with no field
 * redaction (categories, brands, suppliers, member levels, ...). Custom
 * domain logic (products, sales, transfers, ...) gets its own controller.
 *
 * Deletes are hard deletes, but `deleteGuard` can veto them (return a
 * message) when the document is still referenced elsewhere — callers should
 * then deactivate it (active=false) instead so history stays intact.
 */
export function buildCrudRouter(opts: {
  model: Model<any>;
  entityType?: string;
  createSchema: ZodTypeAny;
  updateSchema: ZodTypeAny;
  writeRoles: Role[];
  deleteRoles?: Role[];
  searchFields?: string[];
  /** Query-string keys that map 1:1 to an equality filter, e.g. ['branchId']. */
  filterFields?: string[];
  sort?: Record<string, 1 | -1>;
  /** Extra fields merged into the body on create (e.g. recordedBy from the caller). */
  beforeCreate?: (req: Request, body: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Return a message to block deletion, or null to allow it. */
  deleteGuard?: (doc: any) => Promise<string | null>;
}) {
  const router = Router();
  const {
    model,
    createSchema,
    updateSchema,
    writeRoles,
    deleteRoles = writeRoles,
    searchFields = [],
    filterFields = [],
    sort = { createdAt: -1 },
    beforeCreate,
    deleteGuard,
  } = opts;
  const entityType = opts.entityType ?? model.modelName;

  router.use(requireAuth, requireActiveUser);

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = req.query as Record<string, string | undefined>;
      const filter: Record<string, unknown> = {};
      if (query.active !== undefined) filter.active = query.active === 'true';
      for (const f of filterFields) {
        if (query[f]) filter[f] = query[f];
      }
      if (query.q && searchFields.length > 0) {
        const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = searchFields.map((f) => ({ [f]: { $regex: escaped, $options: 'i' } }));
      }
      const docs = await model.find(filter).sort(sort).limit(500);
      res.json({ items: docs });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const doc = await model.findById(req.params.id);
      if (!doc) throw ApiError.notFound();
      res.json({ item: doc });
    }),
  );

  router.post(
    '/',
    requireRole(...writeRoles),
    validateBody(createSchema),
    asyncHandler(async (req, res) => {
      const body = beforeCreate ? await beforeCreate(req, req.body) : req.body;
      const doc = await model.create(body);
      res.status(201).json({ item: doc });
    }),
  );

  router.patch(
    '/:id',
    requireRole(...writeRoles),
    validateBody(updateSchema),
    asyncHandler(async (req, res) => {
      const doc = await model.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
      if (!doc) throw ApiError.notFound();
      res.json({ item: doc });
    }),
  );

  router.delete(
    '/:id',
    requireRole(...deleteRoles),
    asyncHandler(async (req, res) => {
      const doc = await model.findById(req.params.id);
      if (!doc) throw ApiError.notFound();
      if (deleteGuard) {
        const reason = await deleteGuard(doc);
        if (reason) throw ApiError.conflict(reason);
      }
      await doc.deleteOne();
      await recordAudit({
        userId: req.authUser!.id,
        action: `${entityType.toLowerCase()}.delete`,
        entityType,
        entityId: doc._id.toString(),
        before: doc.toObject(),
      });
      res.status(204).send();
    }),
  );

  return router;
}
