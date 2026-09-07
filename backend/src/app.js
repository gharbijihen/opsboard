import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { ApiError, UnauthorizedError } from './errors.js';
import { createMetrics } from './metrics.js';
import { createRateLimiter } from './rate-limit.js';
import { normalizeIncidentFilters, validateCreateIncident, validateStatusUpdate } from './validation.js';

const BODY_LIMIT_BYTES = 64 * 1024;
const ROUTE_ID = /^\/api\/incidents\/([^/]+)\/status$/;
const ROUTE_ITEM = /^\/api\/incidents\/([^/]+)$/;
const PUBLIC_DIR = resolve(fileURLToPath(new URL('../../frontend', import.meta.url)));
const OPENAPI_FILE = resolve(fileURLToPath(new URL('../../docs/api/openapi.yaml', import.meta.url)));

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8'
};

function securityHeaders(config) {
  const headers = {
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };

  if (config.environment === 'production') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }

  return headers;
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendText(response, status, payload, contentType, headers = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    ...headers
  });
  response.end(payload);
}

function clientIp(request) {
  const forwardedFor = request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim();
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function routeName(request, pathname) {
  if (ROUTE_ID.test(pathname)) {
    return '/api/incidents/:id/status';
  }
  if (ROUTE_ITEM.test(pathname)) {
    return '/api/incidents/:id';
  }
  if (pathname.startsWith('/api/incidents')) {
    return '/api/incidents';
  }
  if (pathname === '/') {
    return '/';
  }
  return pathname;
}

async function parseJsonBody(request) {
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

function requireWriteAccess(request, config, authRateLimiter) {
  if (!config.adminToken) {
    return;
  }

  const authorization = request.headers.authorization ?? '';
  if (authorization === `Bearer ${config.adminToken}`) {
    return;
  }

  authRateLimiter(`auth:${clientIp(request)}`);
  throw new UnauthorizedError();
}

function safePublicPath(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(requested);
  const candidate = resolve(PUBLIC_DIR, `.${decoded}`);

  if (candidate !== PUBLIC_DIR && !candidate.startsWith(`${PUBLIC_DIR}${sep}`)) {
    return null;
  }

  return candidate;
}

async function serveFile(response, filePath, headers) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new ApiError(404, 'NOT_FOUND', 'File was not found');
    }
    throw error;
  }

  if (!fileStat.isFile()) {
    throw new ApiError(404, 'NOT_FOUND', 'File was not found');
  }

  response.writeHead(200, {
    'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=300',
    'Content-Length': fileStat.size,
    'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
    ...headers
  });

  await new Promise((resolvePromise, reject) => {
    createReadStream(filePath)
      .on('error', reject)
      .on('end', resolvePromise)
      .pipe(response);
  });
}

async function handleApi({ authRateLimiter, config, request, response, store, url }) {
  const { method } = request;
  const { pathname, searchParams } = url;

  if (method === 'GET' && pathname === '/healthz') {
    return sendJson(response, 200, { ok: true, version: config.appVersion });
  }

  if (method === 'GET' && pathname === '/readyz') {
    const readiness = await store.ready();
    return sendJson(response, 200, { ...readiness, version: config.appVersion });
  }

  if (method === 'GET' && pathname === '/api/incidents') {
    const filters = normalizeIncidentFilters(searchParams);
    const incidents = await store.list(filters);
    return sendJson(response, 200, { incidents });
  }

  if (method === 'POST' && pathname === '/api/incidents') {
    requireWriteAccess(request, config, authRateLimiter);
    const body = await parseJsonBody(request);
    const incident = await store.create(validateCreateIncident(body));
    return sendJson(response, 201, { incident });
  }

  const statusMatch = pathname.match(ROUTE_ID);
  if (method === 'PATCH' && statusMatch) {
    requireWriteAccess(request, config, authRateLimiter);
    const body = await parseJsonBody(request);
    const { status } = validateStatusUpdate(body);
    const incident = await store.updateStatus(decodeURIComponent(statusMatch[1]), status);
    return sendJson(response, 200, { incident });
  }

  const itemMatch = pathname.match(ROUTE_ITEM);
  if (method === 'DELETE' && itemMatch) {
    requireWriteAccess(request, config, authRateLimiter);
    await store.remove(decodeURIComponent(itemMatch[1]));
    response.writeHead(204);
    return response.end();
  }

  if (method === 'GET' && pathname === '/api/stats') {
    const stats = await store.stats();
    return sendJson(response, 200, { stats });
  }

  throw new ApiError(404, 'NOT_FOUND', 'Route was not found');
}

export function createApp({ config, logger, store }) {
  const metrics = createMetrics();
  const rateLimiter = createRateLimiter({
    max: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs
  });
  const authRateLimiter = createRateLimiter({
    max: config.authRateLimitMax,
    windowMs: config.authRateLimitWindowMs
  });
  const baseHeaders = securityHeaders(config);

  return createServer(async (request, response) => {
    const requestId = request.headers['x-request-id'] || randomUUID();
    const start = process.hrtime.bigint();
    let statusCode = 200;
    let route = 'unknown';

    response.setHeader('X-Request-Id', requestId);

    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      route = routeName(request, url.pathname);

      for (const [key, value] of Object.entries(baseHeaders)) {
        response.setHeader(key, value);
      }

      rateLimiter(`${clientIp(request)}:${url.pathname}`);

      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === 'GET' && url.pathname === '/metrics') {
        return sendText(response, 200, metrics.render(), 'text/plain; version=0.0.4; charset=utf-8');
      }

      if (request.method === 'GET' && url.pathname === '/openapi.yaml') {
        return serveFile(response, OPENAPI_FILE, baseHeaders);
      }

      if (url.pathname.startsWith('/api/') || url.pathname.endsWith('z')) {
        return await handleApi({ authRateLimiter, config, request, response, store, url });
      }

      if (request.method !== 'GET') {
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method is not allowed');
      }

      const publicPath = safePublicPath(url.pathname);
      if (!publicPath) {
        throw new ApiError(400, 'BAD_PATH', 'Invalid path');
      }

      return await serveFile(response, publicPath, baseHeaders);
    } catch (error) {
      const apiError = error instanceof ApiError
        ? error
        : new ApiError(500, 'INTERNAL_ERROR', 'Unexpected server error');
      statusCode = apiError.status;

      if (apiError.status >= 500) {
        logger.error('request failed', {
          error: error.message,
          requestId,
          stack: error.stack
        });
      }

      return sendJson(response, apiError.status, {
        error: {
          code: apiError.code,
          details: apiError.details,
          message: apiError.message,
          requestId
        }
      }, baseHeaders);
    } finally {
      statusCode = response.statusCode || statusCode;

      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      metrics.record({
        durationMs,
        method: request.method ?? 'UNKNOWN',
        route,
        status: statusCode
      });
      logger.info('request completed', {
        durationMs: Number(durationMs.toFixed(2)),
        method: request.method,
        requestId,
        route,
        status: statusCode
      });
    }
  });
}
