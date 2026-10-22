import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import path from 'path';
import { env } from './config/env';
import { logger } from './config/logger';
import routes from './routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: !env.isTest }));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });
  app.use('/api/auth/login', authLimiter);

  // Product photos are shown by the frontend on another origin, so opt out of helmet's same-origin CORP here.
  app.use(
    '/uploads',
    (_req, res, next) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      // Lets the browser draw photos onto a canvas (cropping cap photos out of a tray scan).
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    },
    express.static(path.resolve(process.cwd(), 'uploads'), { maxAge: '7d', immutable: true }),
  );

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/api', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
