import mongoose from 'mongoose';
import { env } from './env';
import { logger } from './logger';

let connected = false;

export async function connectDb(): Promise<void> {
  if (connected) return;

  mongoose.set('strictQuery', true);

  await mongoose.connect(env.mongodbUri, {
    dbName: env.mongodbDb,
    serverSelectionTimeoutMS: 10000,
  });

  connected = true;
  logger.info({ db: env.mongodbDb }, 'MongoDB connected');

  mongoose.connection.on('disconnected', () => {
    connected = false;
    logger.warn('MongoDB disconnected');
  });
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
  connected = false;
}

/**
 * Atlas clusters are always replica sets, so multi-document transactions work
 * in every environment we run against (dev, test, prod) — required for the
 * atomic stock-decrement + ledger + sale writes (spec B6).
 */
export async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result!;
  } finally {
    await session.endSession();
  }
}

function isTransientTransactionError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'hasErrorLabel' in err &&
    typeof (err as { hasErrorLabel: unknown }).hasErrorLabel === 'function' &&
    ((err as { hasErrorLabel: (label: string) => boolean }).hasErrorLabel('TransientTransactionError') ||
      (err as { hasErrorLabel: (label: string) => boolean }).hasErrorLabel('UnknownTransactionCommitResult'))
  );
}

/**
 * Explicit bounded retry on top of the driver's own transaction retry
 * (spec B6, item 4: "Retry อัตโนมัติจำกัดจำนวน... ถ้ายังไม่สำเร็จให้แจ้ง
 * ผู้ใช้และไม่ตัด Stock ครึ่งเดียว"). Only TransientTransactionError /
 * UnknownTransactionCommitResult are retried; any other error (including
 * our own "insufficient stock" ApiError) propagates immediately so the
 * caller is told right away instead of being retried into a stale read.
 */
export async function withTransactionRetry<T>(
  fn: (session: mongoose.ClientSession) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withTransaction(fn);
    } catch (err) {
      lastErr = err;
      if (!isTransientTransactionError(err) || attempt === maxAttempts) throw err;
    }
  }
  throw lastErr;
}
