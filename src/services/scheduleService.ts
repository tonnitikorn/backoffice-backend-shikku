import { ShiftSchedule, IShiftSchedule } from '../models/ShiftSchedule';
import { ShiftDefinition } from '../models/ShiftDefinition';
import { notify } from './notificationService';
import { recordAudit } from './auditService';
import { ApiError } from '../utils/ApiError';

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return timeToMinutes(aStart) < timeToMinutes(bEnd) && timeToMinutes(bStart) < timeToMinutes(aEnd);
}

export interface ScheduleEntryInput {
  userId: string;
  shiftDefinitionId: string;
  date: string; // ISO date
}

export async function upsertScheduleEntries(branchId: string, entries: ScheduleEntryInput[]) {
  const results: IShiftSchedule[] = [];
  for (const entry of entries) {
    const date = new Date(entry.date);
    date.setHours(0, 0, 0, 0);
    const doc = await ShiftSchedule.findOneAndUpdate(
      { branchId, userId: entry.userId, shiftDefinitionId: entry.shiftDefinitionId, date },
      { $setOnInsert: { branchId, userId: entry.userId, shiftDefinitionId: entry.shiftDefinitionId, date, status: 'draft' } },
      { upsert: true, new: true },
    );
    results.push(doc);
  }
  return results;
}

export async function removeScheduleEntry(id: string) {
  await ShiftSchedule.findByIdAndDelete(id);
}

/**
 * Non-blocking warnings for the admin while building the calendar (spec
 * B4): a person double-booked at overlapping times (same or different
 * branches), or an active shift definition with nobody assigned. These
 * never prevent saving — they're surfaced as calendar badges.
 */
export async function detectScheduleConflicts(month: { year: number; month: number }) {
  const start = new Date(month.year, month.month - 1, 1);
  const end = new Date(month.year, month.month, 0, 23, 59, 59, 999);

  const entries = await ShiftSchedule.find({ date: { $gte: start, $lte: end } }).populate('shiftDefinitionId');
  const byUserDate = new Map<string, typeof entries>();
  for (const e of entries) {
    const key = `${e.userId.toString()}_${e.date.toISOString().slice(0, 10)}`;
    if (!byUserDate.has(key)) byUserDate.set(key, []);
    byUserDate.get(key)!.push(e);
  }

  const doubleBooked: Array<{ userId: string; date: string; entries: string[] }> = [];
  for (const [key, group] of byUserDate) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i].shiftDefinitionId as any;
        const b = group[j].shiftDefinitionId as any;
        if (overlaps(a.startTime, a.endTime, b.startTime, b.endTime) || a.branchId?.toString() !== group[i].branchId.toString()) {
          const [userId, date] = key.split('_');
          doubleBooked.push({ userId, date, entries: [group[i]._id.toString(), group[j]._id.toString()] });
        }
      }
    }
  }

  const understaffed: Array<{ branchId: string; shiftDefinitionId: string; date: string }> = [];
  const activeDefs = await ShiftDefinition.find({ active: true });
  for (const def of activeDefs) {
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dayCopy = new Date(d);
      const staffed = entries.some(
        (e) => e.shiftDefinitionId._id.toString() === def._id.toString() && e.date.toDateString() === dayCopy.toDateString(),
      );
      if (!staffed) {
        understaffed.push({ branchId: def.branchId.toString(), shiftDefinitionId: def._id.toString(), date: dayCopy.toISOString().slice(0, 10) });
      }
    }
  }

  return { doubleBooked, understaffed };
}

export async function publishSchedule(branchId: string, month: { year: number; month: number }, publishedBy: string) {
  const start = new Date(month.year, month.month - 1, 1);
  const end = new Date(month.year, month.month, 0, 23, 59, 59, 999);

  const entries = await ShiftSchedule.find({ branchId, date: { $gte: start, $lte: end } }).populate('shiftDefinitionId userId');
  if (entries.length === 0) throw ApiError.badRequest('No schedule entries to publish for this range');

  await ShiftSchedule.updateMany(
    { branchId, date: { $gte: start, $lte: end } },
    { $set: { status: 'published', publishedAt: new Date() } },
  );

  const byUser = new Map<string, typeof entries>();
  for (const e of entries) {
    const key = e.userId._id.toString();
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key)!.push(e);
  }

  for (const [userId, userEntries] of byUser) {
    const summary = userEntries
      .map((e) => `${e.date.toISOString().slice(0, 10)} ${(e.shiftDefinitionId as any).name}`)
      .join('\n');
    await notify({
      type: 'shift_schedule_published',
      userId,
      payload: { branchId, month, count: userEntries.length },
      lineText: `ตารางกะของคุณเดือน ${month.month}/${month.year}:\n${summary}`,
    });
  }

  await recordAudit({
    userId: publishedBy,
    branchId,
    action: 'shift_schedule.publish',
    entityType: 'ShiftSchedule',
    after: { branchId, month, entryCount: entries.length },
  });

  return { publishedCount: entries.length };
}

export async function notifyScheduleChange(scheduleId: string, changedBy: string) {
  const entry = await ShiftSchedule.findById(scheduleId).populate('shiftDefinitionId userId');
  if (!entry || entry.status !== 'published') return;
  const def = entry.shiftDefinitionId as any;
  const user = entry.userId as any;

  await notify({
    type: 'shift_schedule_changed',
    userId: user._id.toString(),
    payload: { scheduleId },
    lineText: `ตารางกะของคุณมีการเปลี่ยนแปลง: ${entry.date.toISOString().slice(0, 10)} ${def.name}`,
  });

  await recordAudit({
    userId: changedBy,
    branchId: entry.branchId,
    action: 'shift_schedule.change_after_publish',
    entityType: 'ShiftSchedule',
    entityId: entry._id.toString(),
  });
}

export async function getMySchedule(userId: string, month: { year: number; month: number }) {
  const start = new Date(month.year, month.month - 1, 1);
  const end = new Date(month.year, month.month, 0, 23, 59, 59, 999);
  return ShiftSchedule.find({ userId, status: 'published', date: { $gte: start, $lte: end } })
    .populate('shiftDefinitionId branchId')
    .sort({ date: 1 });
}

export async function getCalendar(branchId: string, month: { year: number; month: number }) {
  const start = new Date(month.year, month.month - 1, 1);
  const end = new Date(month.year, month.month, 0, 23, 59, 59, 999);
  return ShiftSchedule.find({ branchId, date: { $gte: start, $lte: end } })
    .populate('shiftDefinitionId userId')
    .sort({ date: 1 });
}
