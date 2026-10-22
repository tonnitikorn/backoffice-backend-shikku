import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';
import { ApiError } from '../utils/ApiError';
import { logger } from '../config/logger';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route: ${req.method} ${req.path}` } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง', details: err.flatten() },
    });
  }

  if (err instanceof ApiError) {
    if (err.status >= 500) logger.error({ err }, err.message);
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }

  // Unique-index violation, e.g. a duplicate branch code, SKU code or email.
  if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
    const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue ?? {};
    const fields = Object.keys(keyValue).join(', ');
    return res.status(409).json({
      error: { code: 'DUPLICATE', message: `ข้อมูลซ้ำกับที่มีอยู่แล้ว${fields ? ` (${fields})` : ''}`, details: keyValue },
    });
  }

  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'ข้อมูลไม่ถูกต้อง', details: Object.keys(err.errors) },
    });
  }

  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: `รูปแบบข้อมูลไม่ถูกต้อง (${err.path})` } });
  }

  logger.error({ err }, 'Unhandled error');
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
