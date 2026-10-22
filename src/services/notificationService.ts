import { Types } from 'mongoose';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { NotificationType } from '../config/constants';
import { sendLineMessage } from '../lib/lineClient';

export interface NotifyInput {
  type: NotificationType;
  userId?: string | Types.ObjectId;
  role?: 'admin' | 'branch_manager' | 'staff';
  branchId?: string | Types.ObjectId;
  payload?: Record<string, unknown>;
  lineText?: string; // if provided, also attempt a LINE push to the target user(s)
}

/**
 * Always writes an in-system notification first (the guaranteed channel),
 * then best-effort attempts LINE push for any resolved recipients with a
 * linked LINE account. LINE failure never blocks the in-system record.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const doc = await Notification.create({
    type: input.type,
    userId: input.userId,
    role: input.role,
    branchId: input.branchId,
    payload: input.payload ?? {},
  });

  if (!input.lineText) return;

  const recipients = input.userId
    ? await User.find({ _id: input.userId, lineUserId: { $exists: true, $ne: '' } })
    : input.role
      ? await User.find({
          role: input.role,
          ...(input.branchId ? { branchIds: input.branchId } : {}),
          lineUserId: { $exists: true, $ne: '' },
        })
      : [];

  if (recipients.length === 0) return;

  doc.lineDeliveryAttempted = true;
  let anySucceeded = false;
  for (const user of recipients) {
    const ok = await sendLineMessage(user.lineUserId!, input.lineText);
    if (ok) anySucceeded = true;
  }
  doc.lineDeliverySucceeded = anySucceeded;
  await doc.save();
}

export async function getNotificationsForUser(userId: string, unreadOnly = false) {
  const filter: Record<string, unknown> = { userId };
  if (unreadOnly) filter.readAt = null;
  return Notification.find(filter).sort({ createdAt: -1 }).limit(100);
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  await Notification.findByIdAndUpdate(notificationId, { $set: { readAt: new Date() } });
}
