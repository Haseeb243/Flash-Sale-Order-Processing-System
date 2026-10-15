import { z } from 'zod';
import { AppError } from './errors';

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw new AppError(400, 'VALIDATION_ERROR', message);
  }
  return result.data;
}

export const createOrderBody = z.strictObject({
  customer_id: z.string().min(1).max(100),
  product_id: z.string().min(1).max(100),
  quantity: z.number().int().min(1).max(100),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export const idempotencyKey = z.string().min(1).max(200);

export const orderIdParam = z.uuid();

export const listOrdersQuery = z.object({
  customer_id: z.string().min(1).max(100),
});

export const paymentEventBody = z.strictObject({
  event_id: z.string().min(1).max(200),
  order_id: z.uuid(),
  status: z.enum(['payment_succeeded', 'payment_failed']),
});
