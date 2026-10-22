import { IUser } from '../models/User';
import { resolvePermission } from './permissionService';
import { ApiError } from '../utils/ApiError';

/**
 * Enforces the "staff cannot see reports/ledger older than N days" rule at
 * the API layer (spec B3) — never just hidden in the UI. If the caller has
 * no history limit (reportsHistoryDays === null) the requested range passes
 * through unchanged. If they do, a `from` earlier than the allowed cutoff
 * is REJECTED (matching the spec's own test case: "Staff calling the report
 * API for 7 days back must be rejected"), and an absent `from` is defaulted
 * to the cutoff so unrestricted requests still come back scoped.
 */
export async function applyReportHistoryLimit(
  user: Pick<IUser, 'role' | 'permissionOverrides'>,
  range: { from?: string | Date; to?: string | Date },
): Promise<{ from?: Date; to?: Date }> {
  const historyDays = await resolvePermission(user, 'reportsHistoryDays');

  const to = range.to ? new Date(range.to) : undefined;

  if (historyDays === null || historyDays === undefined) {
    return { from: range.from ? new Date(range.from) : undefined, to };
  }

  const days = historyDays as number;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));

  if (range.from) {
    const requestedFrom = new Date(range.from);
    if (requestedFrom < cutoff) {
      throw ApiError.forbidden(`You may only view data from the last ${days} day(s)`);
    }
    return { from: requestedFrom, to };
  }

  return { from: cutoff, to };
}
