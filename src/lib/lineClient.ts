import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Thin LINE Messaging API wrapper. When no channel access token is
 * configured (spec: no LINE OA credentials yet), sends are no-ops that log
 * and report failure so the caller always falls back to the in-system
 * notification (spec B4: "ถ้าส่ง LINE ไม่สำเร็จ ต้องมี Notification ในระบบ
 * เป็นทางสำรองเสมอ"). Drop real credentials into .env to activate it —
 * no code change needed.
 */
export async function sendLineMessage(lineUserId: string, text: string): Promise<boolean> {
  if (!env.lineChannelAccessToken) {
    logger.debug({ lineUserId, text }, 'LINE not configured — skipping push, in-system notification stands');
    return false;
  }

  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.lineChannelAccessToken}`,
      },
      body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'LINE push failed');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, 'LINE push threw');
    return false;
  }
}
