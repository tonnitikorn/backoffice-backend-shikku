import { Types } from 'mongoose';
import { Setting, SETTING_DEFAULTS } from '../models/Setting';
import { recordAudit } from './auditService';

export async function getSetting<T = unknown>(key: string): Promise<T> {
  const doc = await Setting.findOne({ key });
  if (doc) return doc.value as T;
  if (key in SETTING_DEFAULTS) return SETTING_DEFAULTS[key] as T;
  throw new Error(`Unknown setting key: ${key}`);
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const docs = await Setting.find();
  const result: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const doc of docs) result[doc.key] = doc.value;
  return result;
}

export async function setSetting(
  key: string,
  value: unknown,
  updatedBy: Types.ObjectId | string,
): Promise<void> {
  const before = await Setting.findOne({ key });
  await Setting.findOneAndUpdate(
    { key },
    { $set: { value, updatedBy } },
    { upsert: true, setDefaultsOnInsert: true },
  );
  await recordAudit({
    userId: updatedBy,
    action: 'settings.update',
    entityType: 'Setting',
    entityId: key,
    before: before?.value ?? SETTING_DEFAULTS[key] ?? null,
    after: value,
  });
}
