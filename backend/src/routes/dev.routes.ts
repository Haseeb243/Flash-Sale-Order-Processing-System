import { Router } from 'express';
import { resetDemoData } from '../services/products.service';

export const devRouter = Router();

devRouter.post('/reset', async (_req, res) => {
  await resetDemoData();
  res.json({ ok: true });
});
