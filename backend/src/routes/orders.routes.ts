import { Router } from 'express';
import { createOrderBody, idempotencyKey, listOrdersQuery, orderIdParam, parse } from '../validation';
import { createOrder, getOrder, listOrders } from '../services/orders.service';
import { expireReservations } from '../services/expiry.service';

export const ordersRouter = Router();

ordersRouter.post('/', async (req, res) => {
  const body = parse(createOrderBody, req.body);
  const key = parse(idempotencyKey, body.idempotency_key ?? req.get('Idempotency-Key'));
  const { order, replayed } = await createOrder({
    customerId: body.customer_id,
    productId: body.product_id,
    quantity: body.quantity,
    idempotencyKey: key,
  });
  if (replayed) {
    res.set('Idempotent-Replayed', 'true').status(200).json(order);
  } else {
    res.status(201).json(order);
  }
});

ordersRouter.get('/', async (req, res) => {
  const { customer_id } = parse(listOrdersQuery, req.query);
  res.json(await listOrders(customer_id));
});

ordersRouter.post('/expire', async (_req, res) => {
  res.json(await expireReservations());
});

ordersRouter.get('/:id', async (req, res) => {
  res.json(await getOrder(parse(orderIdParam, req.params.id)));
});
