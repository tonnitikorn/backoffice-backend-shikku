import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth, requireActiveUser } from '../middleware/auth';
import * as notificationService from '../services/notificationService';

const router = Router();
router.use(requireAuth, requireActiveUser);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unreadOnly === 'true';
    res.json({ items: await notificationService.getNotificationsForUser(req.authUser!.id, unreadOnly) });
  }),
);

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    await notificationService.markNotificationRead(req.params.id);
    res.status(204).send();
  }),
);

export default router;
