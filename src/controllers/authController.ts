import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { validateBody } from '../utils/validate';
import * as authService from '../services/authService';
import { requireAuth } from '../middleware/auth';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { resolveAllPermissions } from '../services/permissionService';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await authService.login(email, password);
    res.json(result);
  }),
);

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

router.post(
  '/refresh',
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.refresh(req.body.refreshToken);
    res.json(result);
  }),
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await authService.revokeAllSessions(req.authUser!.id);
    res.status(204).send();
  }),
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.authUser!.id);
    if (!user) throw ApiError.unauthorized();
    const permissions = await resolveAllPermissions(user);
    res.json({ user: authService.sanitizeUser(user), permissions });
  }),
);

export default router;
