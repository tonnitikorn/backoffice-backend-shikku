import dotenv from 'dotenv';
import path from 'path';

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
  port: Number(process.env.PORT ?? 4000),

  mongodbUri: required('MONGODB_URI'),
  mongodbDb: required('MONGODB_DB'),

  jwtAccessSecret: required('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',

  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',

  lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '',
  lineChannelSecret: process.env.LINE_CHANNEL_SECRET ?? '',

  // Reading stock from tray photos (Claude vision). Without it, staff read the photo in the Claude app and paste the reply back.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  stockScanModel: process.env.STOCK_SCAN_MODEL ?? 'claude-opus-5',

  s3Bucket: process.env.S3_BUCKET ?? '',
  s3Region: process.env.S3_REGION ?? '',
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
};
