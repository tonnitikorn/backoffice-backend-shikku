/* eslint-disable no-console */
/**
 * Demo data for the per-shift stock sheet: creates the default count groups (if none exist)
 * and back-fills "Stock ก่อนขาย / หลังขาย" for shifts of the last N days, rebuilt from the
 * stock ledger at the moment of each count. About 1 in 8 counts is deliberately off by one
 * so the handover/variance checks have something to show. Skips shifts that already have counts.
 *
 *   npx tsx src/seed/seedStockCounts.ts [--days 7]
 */
import { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../config/db';
import { User } from '../models/User';
import { Branch } from '../models/Branch';
import { ShiftSession } from '../models/ShiftSession';
import { ShiftStockCount } from '../models/ShiftStockCount';
import { StockCountGroup } from '../models/StockCountGroup';
import { ProductSku } from '../models/ProductSku';
import { Inventory } from '../models/Inventory';
import { InventoryTransaction } from '../models/InventoryTransaction';
import { buildGroupResolver, createDefaultGroups, getActiveGroups } from '../services/stockCountService';

const MIN = 60000;
let rng = 930;
const rand = () => ((rng = (rng * 1664525 + 1013904223) % 4294967296) / 4294967296);

async function main() {
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 7;
  await connectDb();

  const admin = await User.findOne({ role: 'admin' });
  if (!(await StockCountGroup.exists({}))) {
    const created = await createDefaultGroups(admin!._id.toString());
    console.log(`Created ${created.length} default count groups`);
  }
  const groups = await getActiveGroups();
  const resolve = buildGroupResolver(groups);
  const productIds = [...new Set(groups.flatMap((g) => g.productIds.map(String)))];
  const skuGroup = new Map<string, string>();
  for (const s of await ProductSku.find({ productId: { $in: productIds } }, { productId: 1, power: 1 })) {
    const g = resolve(s);
    if (g) skuGroup.set(s._id.toString(), g._id.toString());
  }

  const since = new Date(Date.now() - days * 24 * 60 * MIN);
  for (const branch of await Branch.find()) {
    // Group quantity at time T = quantity now − every ledger change after T.
    const now = new Map<string, number>(groups.map((g) => [g._id.toString(), 0]));
    for (const inv of await Inventory.find({ branchId: branch._id }, { skuId: 1, qtyOnHand: 1 })) {
      const gid = skuGroup.get(inv.skuId.toString());
      if (gid) now.set(gid, now.get(gid)! + inv.qtyOnHand);
    }
    const txns = (await InventoryTransaction.find({ branchId: branch._id, createdAt: { $gt: since } }, { skuId: 1, qtyChange: 1, createdAt: 1 }))
      .map((t) => ({ gid: skuGroup.get(t.skuId.toString()), qty: t.qtyChange, at: t.createdAt.getTime() }))
      .filter((t) => t.gid);
    const qtyAt = (t: Date) => {
      const q = new Map(now);
      for (const x of txns) if (x.at > t.getTime()) q.set(x.gid!, q.get(x.gid!)! - x.qty);
      return q;
    };

    const sessions = await ShiftSession.find({ branchId: branch._id, openedAt: { $gte: since } }).sort({ openedAt: 1 });
    let written = 0;
    for (const s of sessions) {
      if (await ShiftStockCount.exists({ shiftSessionId: s._id })) continue;
      const phases: ['open' | 'close', Date][] = [['open', new Date(s.openedAt.getTime() + 5 * MIN)]];
      if (s.closedAt) phases.push(['close', new Date(s.closedAt.getTime() - 2 * MIN)]);
      for (const [phase, at] of phases) {
        const q = qtyAt(at);
        const off = rand() < 0.125 ? groups[Math.floor(rand() * Math.min(groups.length, 6))]._id.toString() : null;
        await ShiftStockCount.collection.insertOne({
          shiftSessionId: s._id,
          branchId: branch._id,
          phase,
          lines: groups.map((g) => {
            const gid = g._id.toString();
            const system = Math.max(0, q.get(gid) ?? 0);
            return { groupId: new Types.ObjectId(gid), groupName: g.name, systemQty: system, countedQty: gid === off && system > 0 ? system - 1 : system };
          }),
          note: off ? '[DEMO] นับไม่ครบ 1 คู่' : undefined,
          countedBy: s.userId,
          countedAt: at,
          createdAt: at,
          updatedAt: at,
          __v: 0,
        });
        written += 1;
      }
    }
    console.log(`${branch.name}: ${sessions.length} shifts, ${written} counts written`);
  }
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
