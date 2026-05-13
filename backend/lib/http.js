export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch { throw fail(400, 'Invalid JSON body'); }
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw fail(400, 'Invalid JSON body'); }
}

export function send(res, status, payload = null) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload ?? {}));
}

export function ok(res, payload = {}) {
  send(res, 200, payload);
}

export function created(res, payload = {}) {
  send(res, 201, payload);
}

export function noContent(res) {
  res.statusCode = 204;
  res.end();
}

export function fail(status, message, details = undefined) {
  const error = new Error(message);
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

export function handleError(res, error) {
  const status = error.status || error.statusCode || 500;
  send(res, status, {
    error: {
      message: status === 500 ? 'Internal server error' : error.message,
      details: error.details
    }
  });
}

export function methodNotAllowed(res) {
  send(res, 405, { error: { message: 'Method not allowed' } });
}
