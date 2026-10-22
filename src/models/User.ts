import { Schema, model, Types } from 'mongoose';
import { ROLES, Role, PermissionKey } from '../config/constants';

export interface IUser {
  _id: Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  branchIds: Types.ObjectId[];
  lineUserId?: string;
  permissionOverrides?: Partial<Record<PermissionKey, boolean | number | null>>;
  active: boolean;
  lastLoginAt?: Date;
  refreshTokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    branchIds: [{ type: Schema.Types.ObjectId, ref: 'Branch' }],
    lineUserId: { type: String },
    permissionOverrides: { type: Schema.Types.Mixed },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
    refreshTokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const User = model<IUser>('User', userSchema);
