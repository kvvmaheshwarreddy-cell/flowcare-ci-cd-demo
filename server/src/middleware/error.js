class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wraps async route handlers so thrown errors reach the error handler. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Minimal request validation: rules = { field: { required, type, enum, min } } */
function validate(body, rules) {
  const errors = [];
  for (const [field, r] of Object.entries(rules)) {
    const v = body[field];
    if (v === undefined || v === null || v === '') {
      if (r.required) errors.push(`${field} is required`);
      continue;
    }
    if (r.type === 'number' && (typeof v !== 'number' || Number.isNaN(v))) errors.push(`${field} must be a number`);
    if (r.type === 'string' && typeof v !== 'string') errors.push(`${field} must be text`);
    if (r.type === 'date' && Number.isNaN(new Date(v).getTime())) errors.push(`${field} must be a valid date`);
    if (r.enum && !r.enum.includes(v)) errors.push(`${field} must be one of: ${r.enum.join(', ')}`);
    if (r.min !== undefined && typeof v === 'number' && v < r.min) errors.push(`${field} must be at least ${r.min}`);
  }
  if (errors.length) throw new HttpError(400, 'Validation failed', errors);
}

function notFound(req, res, next) {
  next(new HttpError(404, 'Endpoint not found'));
}

function errorHandler(err, req, res, next) {
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'Validation failed', details: Object.values(err.errors).map((e) => e.message) });
  }
  if (err.name === 'CastError') return res.status(400).json({ error: `Invalid ${err.path}` });
  if (err.code === 11000) return res.status(409).json({ error: 'Duplicate value', details: err.keyValue });
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message, details: err.details });
}

module.exports = { HttpError, wrap, validate, notFound, errorHandler };
