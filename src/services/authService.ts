import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { User, IUser } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { Role } from '../config/constants';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  branchIds: string[];
  tokenVersion: number;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signAccessToken(user: IUser): string {
  const payload: AccessTokenPayload = {
    sub: user._id.toString(),
    role: user.role,
    branchIds: user.branchIds.map((b) => b.toString()),
    tokenVersion: user.refreshTokenVersion,
  };
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.jwtAccessTtl as jwt.SignOptions['expiresIn'] });
}

export function signRefreshToken(user: IUser): string {
  return jwt.sign(
    { sub: user._id.toString(), tokenVersion: user.refreshTokenVersion },
    env.jwtRefreshSecret,
    { expiresIn: env.jwtRefreshTtl as jwt.SignOptions['expiresIn'] },
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.jwtAccessSecret) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): { sub: string; tokenVersion: number } {
  return jwt.verify(token, env.jwtRefreshSecret) as { sub: string; tokenVersion: number };
}

export async function login(email: string, password: string) {
  const user = await User.findOne({ email: email.toLowerCase(), active: true }).select('+passwordHash');
  if (!user) throw ApiError.unauthorized('Invalid email or password');

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw ApiError.unauthorized('Invalid email or password');

  user.lastLoginAt = new Date();
  await user.save();

  return {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
    user: sanitizeUser(user),
  };
}

export async function refresh(refreshToken: string) {
  let decoded: { sub: string; tokenVersion: number };
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('Invalid refresh token');
  }

  const user = await User.findById(decoded.sub);
  if (!user || !user.active) throw ApiError.unauthorized('Invalid refresh token');
  if (user.refreshTokenVersion !== decoded.tokenVersion) {
    throw ApiError.unauthorized('Refresh token revoked');
  }

  return {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
    user: sanitizeUser(user),
  };
}

export async function revokeAllSessions(userId: Types.ObjectId | string): Promise<void> {
  await User.findByIdAndUpdate(userId, { $inc: { refreshTokenVersion: 1 } });
}

export function sanitizeUser(user: IUser) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    branchIds: user.branchIds.map((b) => b.toString()),
    active: user.active,
  };
}
