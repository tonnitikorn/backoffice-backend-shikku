import { logger } from '../config/logger';
import { reconcileInventory } from '../services/inventoryService';
import { notifyOverdueTransfers } from '../services/transferService';
import { notify } from '../services/notificationService';

/**
 * Runs the once-a-day housekeeping the spec calls for: stock ledger vs
 * on-hand reconciliation (B6 — alert admin on mismatch) and overdue
 * transfer notifications (B7). Scheduled from src/index.ts with a plain
 * interval timer; swap for a real scheduler (cron) if this ever needs to
 * survive across multiple server instances.
 */
export async function runDailyJobs(): Promise<void> {
  try {
    const mismatches = await reconcileInventory();
    if (mismatches.length > 0) {
      logger.warn({ mismatches }, 'Inventory reconciliation found mismatches');
      await notify({ type: 'stock_adjustment', role: 'admin', payload: { mismatches } });
    }
  } catch (err) {
    logger.error({ err }, 'Inventory reconciliation job failed');
  }

  try {
    const count = await notifyOverdueTransfers();
    if (count > 0) logger.info({ count }, 'Overdue transfer notifications sent');
  } catch (err) {
    logger.error({ err }, 'Overdue transfer job failed');
  }
}
