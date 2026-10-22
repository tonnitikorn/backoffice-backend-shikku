import { Types, ClientSession } from 'mongoose';
import { AuditLog } from '../models/AuditLog';

export interface AuditEntry {
  userId?: Types.ObjectId | string;
  branchId?: Types.ObjectId | string;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  refDoc?: string;
}

export async function recordAudit(entry: AuditEntry, session?: ClientSession): Promise<void> {
  await AuditLog.create([{ ...entry }], { session });
}
