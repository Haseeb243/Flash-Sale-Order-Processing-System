import type { ErrorRequestHandler } from 'express';

export class AppError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // body-parser sets type on JSON parse failures
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
    return;
  }
  // statement_timeout (57014), lock_timeout (55P03), pool connect timeout: transient, safe to retry.
  if (err?.code === '57014' || err?.code === '55P03' || /timeout exceeded when trying to connect/i.test(err?.message ?? '')) {
    res.status(503).set('Retry-After', '1').json({ error: { code: 'BUSY', message: 'Server busy, please retry' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
};
