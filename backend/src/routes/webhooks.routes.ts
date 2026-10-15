import { Router } from 'express';
import { paymentEventBody, parse } from '../validation';
import { handlePaymentEvent } from '../services/payments.service';

export const webhooksRouter = Router();

webhooksRouter.post('/payment', async (req, res) => {
  const body = parse(paymentEventBody, req.body);
  res.json(
    await handlePaymentEvent({ eventId: body.event_id, orderId: body.order_id, status: body.status }),
  );
});
