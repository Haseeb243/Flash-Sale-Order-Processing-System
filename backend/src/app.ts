import cors from 'cors';
import express from 'express';
import { config } from './config';
import { errorHandler } from './errors';
import { devRouter } from './routes/dev.routes';
import { ordersRouter } from './routes/orders.routes';
import { productsRouter } from './routes/products.routes';
import { webhooksRouter } from './routes/webhooks.routes';

export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/products', productsRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/webhooks', webhooksRouter);
  if (config.allowDevReset) app.use('/api/dev', devRouter);

  app.use(errorHandler);
  return app;
}
