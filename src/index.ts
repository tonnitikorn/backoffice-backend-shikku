import { createApp } from './app';
import { connectDb } from './config/db';
import { env } from './config/env';
import { logger } from './config/logger';
import { runDailyJobs } from './jobs/dailyJobs';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  await connectDb();
  const app = createApp();
  app.listen(env.port, () => {
    logger.info(`Server listening on port ${env.port} (${env.nodeEnv})`);
  });

  if (!env.isTest) {
    setInterval(() => void runDailyJobs(), ONE_DAY_MS);
  }
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
