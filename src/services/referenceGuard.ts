import { Model } from 'mongoose';

export type ReferenceCheck = [model: Model<any>, filter: Record<string, unknown>, label: string];

/**
 * Returns a user-facing (Thai) message naming the first collection that
 * still references the document, or null when it is safe to hard-delete.
 * Used as a crudFactory deleteGuard so referenced master data gets
 * deactivated instead of deleted and history stays intact.
 */
export async function findBlockingReference(entityLabel: string, checks: ReferenceCheck[]): Promise<string | null> {
  for (const [model, filter, label] of checks) {
    if (await model.exists(filter)) {
      return `ไม่สามารถลบ${entityLabel}ได้ เนื่องจากมีการใช้งานอยู่ใน${label} — กรุณาปิดใช้งานแทน`;
    }
  }
  return null;
}
