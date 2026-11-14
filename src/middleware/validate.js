import { badRequest } from '../utils/errors.js';

// zod validation middleware. Usage:
//   router.post('/', validate({ body: schema }), handler)
// Parsed values replace the raw values on req (coerced numbers, defaults).
export function validate(schemas) {
  return (req, res, next) => {
    try {
      for (const key of ['body', 'query', 'params']) {
        const schema = schemas[key];
        if (!schema) continue;
        const result = schema.safeParse(req[key]);
        if (!result.success) {
          const details = result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          }));
          throw badRequest(`Invalid ${key}`, details);
        }
        // req.query is a getter on some Express versions; keep a separate object.
        if (key === 'query') {
          req.validatedQuery = result.data;
        } else {
          req[key] = result.data;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
