import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../services/authService';
import { ApiError } from '../utils/ApiError';
import { Role } from '../config/constants';
import { User } from '../models/User';

export interface AuthUser {
  id: string;
  role: Role;
  branchIds: string[];
  tokenVersion: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(ApiError.unauthorized('Missing access token'));
  }
  const token = header.slice('Bearer '.length);
  try {
    const payload = verifyAccessToken(token);
    req.authUser = {
      id: payload.sub,
      role: payload.role,
      branchIds: payload.branchIds,
      tokenVersion: payload.tokenVersion,
    };
    next();
  } catch {
    next(ApiError.unauthorized('Invalid or expired access token'));
  }
}

/**
 * Re-checks the user is still active and the access token's tokenVersion
 * matches the current refreshTokenVersion, so a revoked/disabled user's
 * still-live access token stops working immediately rather than waiting
 * for expiry.
 */
export async function requireActiveUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.authUser) return next(ApiError.unauthorized());
  const user = await User.findById(req.authUser.id);
  if (!user || !user.active || user.refreshTokenVersion !== req.authUser.tokenVersion) {
    return next(ApiError.unauthorized('Session no longer valid'));
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.authUser) return next(ApiError.unauthorized());
    if (!roles.includes(req.authUser.role)) {
      return next(ApiError.forbidden(`Requires role: ${roles.join(', ')}`));
    }
    next();
  };
}

/**
 * Enforces the caller can only act on the branch they're scoped to.
 * Reads the target branch id from params.branchId, query.branchId or
 * body.branchId (checked in that order). Admins bypass this check.
 */
export function requireBranchScope(getBranchId: (req: Request) => string | undefined = defaultBranchIdExtractor) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.authUser) return next(ApiError.unauthorized());
    if (req.authUser.role === 'admin') return next();

    const branchId = getBranchId(req);
    if (!branchId) return next(ApiError.badRequest('branchId is required'));

    if (!req.authUser.branchIds.includes(branchId)) {
      return next(ApiError.forbidden('You do not have access to this branch'));
    }
    next();
  };
}

function defaultBranchIdExtractor(req: Request): string | undefined {
  return (req.params.branchId || (req.query.branchId as string) || req.body?.branchId) ?? undefined;
}
