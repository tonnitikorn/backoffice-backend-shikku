import { DEFAULT_PERMISSIONS, PermissionKey, Role } from '../config/constants';
import { getSetting } from './settingsService';
import { SETTING_KEYS } from '../models/Setting';
import { IUser } from '../models/User';

type PermissionValue = boolean | number | null;

/**
 * Resolves an effective permission for a user: role default -> admin's
 * per-role override (settings.permission_overrides_by_role) -> per-user
 * override (user.permissionOverrides). Backend is the sole enforcement
 * point (spec B3) — the frontend must never assume a permission from role
 * name alone.
 */
export async function resolvePermission(user: Pick<IUser, 'role' | 'permissionOverrides'>, key: PermissionKey): Promise<PermissionValue> {
  const roleDefaults = DEFAULT_PERMISSIONS[user.role] as Record<PermissionKey, PermissionValue>;
  let value: PermissionValue = roleDefaults[key];

  const roleOverrides = await getSetting<Record<string, Partial<Record<PermissionKey, PermissionValue>>>>(
    SETTING_KEYS.permissionOverridesByRole,
  );
  const roleOverride = roleOverrides?.[user.role]?.[key];
  if (roleOverride !== undefined) value = roleOverride;

  const userOverride = user.permissionOverrides?.[key];
  if (userOverride !== undefined) value = userOverride as PermissionValue;

  return value;
}

export async function resolveAllPermissions(
  user: Pick<IUser, 'role' | 'permissionOverrides'>,
): Promise<Record<PermissionKey, PermissionValue>> {
  const keys = Object.keys(DEFAULT_PERMISSIONS.admin) as PermissionKey[];
  const entries = await Promise.all(keys.map(async (k) => [k, await resolvePermission(user, k)] as const));
  return Object.fromEntries(entries) as Record<PermissionKey, PermissionValue>;
}

export function userHasBranch(user: Pick<IUser, 'branchIds' | 'role'>, branchId: string): boolean {
  if (user.role === 'admin') return true;
  return user.branchIds.map((b) => b.toString()).includes(branchId.toString());
}
