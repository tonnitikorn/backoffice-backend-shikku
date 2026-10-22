import { Schema, model, Types } from 'mongoose';
import { NOTIFICATION_TYPES, NotificationType } from '../config/constants';

export interface INotification {
  _id: Types.ObjectId;
  type: NotificationType;
  userId?: Types.ObjectId; // targeted at one user
  role?: string; // or broadcast to a role
  branchId?: Types.ObjectId; // scoped to a branch
  payload: Record<string, unknown>;
  lineDeliveryAttempted: boolean;
  lineDeliverySucceeded: boolean;
  readAt?: Date;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    role: { type: String },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch' },
    payload: { type: Schema.Types.Mixed, default: {} },
    lineDeliveryAttempted: { type: Boolean, default: false },
    lineDeliverySucceeded: { type: Boolean, default: false },
    readAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ branchId: 1, createdAt: -1 });

export const Notification = model<INotification>('Notification', notificationSchema);
