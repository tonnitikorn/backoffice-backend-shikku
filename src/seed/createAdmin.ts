/* eslint-disable no-console */
import crypto from 'crypto';
import { connectDb, disconnectDb } from '../config/db';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { User } from '../models/User';
import { Setting, SETTING_KEYS } from '../models/Setting';
import { hashPassword } from '../services/authService';

/**
 * Bootstraps a fresh (e.g. production) database with its first admin, without
 * touching anything else — unlike `seed`, which wipes the db. Refuses to run
 * once any user exists.
 *
 *   ADMIN_EMAIL=owner@example.com ADMIN_NAME="เจ้าของร้าน" npm run create-admin
 */
async function main() {
  const email = process.env.ADMIN_EMAIL;
  const name = process.env.ADMIN_NAME ?? 'เจ้าของร้าน';
  if (!email) throw new Error('Set ADMIN_EMAIL');

  await connectDb();

  if ((await User.countDocuments()) > 0) {
    throw new Error(`Database "${env.mongodbDb}" already has users — refusing to create another admin`);
  }

  await Setting.updateOne(
    { key: SETTING_KEYS.openingFloatStandardByBranch },
    { $setOnInsert: { value: {} } },
    { upsert: true },
  );

  const password = crypto.randomBytes(12).toString('base64url');
  await User.create({ name, email, passwordHash: await hashPassword(password), role: 'admin', branchIds: [] });

  console.log(`\nAdmin created in "${env.mongodbDb}":`);
  console.log(`  ${email} / ${password}`);
  console.log('Change this password after the first login.\n');

  await disconnectDb();
}

main().catch(async (err) => {
  logger.error({ err }, 'create-admin failed');
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
