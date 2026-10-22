import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import { nanoid } from 'nanoid';
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from './ApiError';

const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');
const EXT: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/** Single-image upload under uploads/<folder>/, served at /uploads/<folder>/<file>. */
export function imageUpload(folder: string, field = 'image') {
  const dir = path.join(UPLOAD_ROOT, folder);
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir), (err) => cb(err, dir));
      },
      filename: (_req, file, cb) => cb(null, `${nanoid(16)}${EXT[file.mimetype]}`),
    }),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (EXT[file.mimetype]) cb(null, true);
      else cb(ApiError.badRequest('รองรับเฉพาะไฟล์รูป JPG, PNG หรือ WEBP'));
    },
  }).single(field);

  return (req: Request, res: Response, next: NextFunction) =>
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) return next(ApiError.badRequest(err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 8MB' : err.message));
      if (err) return next(err);
      if (!req.file) return next(ApiError.badRequest('กรุณาเลือกไฟล์รูป'));
      next();
    });
}

export function publicUrlFor(folder: string, filename: string) {
  return `/uploads/${folder}/${filename}`;
}

/** Deletes a file previously returned by publicUrlFor; ignores anything outside the uploads dir. */
export async function removeUploadedFile(publicUrl: string) {
  const resolved = path.resolve(UPLOAD_ROOT, publicUrl.replace(/^\/uploads\//, ''));
  if (!resolved.startsWith(UPLOAD_ROOT + path.sep)) return;
  await fs.unlink(resolved).catch(() => undefined);
}
