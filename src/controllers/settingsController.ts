import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import { requireAuth, requireActiveUser, requireRole } from '../middleware/auth';
import * as settingsService from '../services/settingsService';

const router = Router();
router.use(requireAuth, requireActiveUser);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ settings: await settingsService.getAllSettings() });
  }),
);

const updateSchema = z.object({ value: z.unknown() });

router.put(
  '/:key',
  requireRole('admin'),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    await settingsService.setSetting(req.params.key, req.body.value, req.authUser!.id);
    res.json({ key: req.params.key, value: req.body.value });
  }),
);

export default router;
