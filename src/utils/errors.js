// Consistent error shape for every failed API call:
// { error: { code, message, details? } }

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) =>
  new AppError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'forbidden', message);

export const notFound = (message = 'Resource not found') =>
  new AppError(404, 'not_found', message);

export const conflict = (message, details) =>
  new AppError(409, 'conflict', message, details);

export const tooManyRequests = (message = 'Too many requests') =>
  new AppError(429, 'rate_limited', message);

export const serverError = (message = 'Internal server error') =>
  new AppError(500, 'server_error', message);

// Express error handler. Keep messages safe: 5xx errors never leak internals.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }

  // Safety net for schemas parsed outside the validate() middleware.
  if (err?.name === 'ZodError' && Array.isArray(err.issues)) {
    return res.status(400).json({
      error: {
        code: 'bad_request',
        message: err.issues[0]?.message ?? 'Request validation failed',
        details: err.issues.slice(0, 8).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }

  // Body parser / malformed JSON
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'bad_json', message: 'Request body is not valid JSON' },
    });
  }

  // mysql2 duplicate key
  if (err?.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      error: { code: 'conflict', message: 'A record with these values already exists' },
    });
  }

  if (err?.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(400).json({
      error: { code: 'bad_reference', message: 'A referenced record does not exist' },
    });
  }

  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({
    error: { code: 'server_error', message: 'Internal server error' },
  });
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'not_found', message: `No route for ${req.method} ${req.originalUrl}` },
  });
}
