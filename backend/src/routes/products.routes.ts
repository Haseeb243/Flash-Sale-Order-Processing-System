import { Router } from 'express';
import { listProducts } from '../services/products.service';

export const productsRouter = Router();

productsRouter.get('/', async (_req, res) => {
  res.json(await listProducts());
});
