import { resolve } from 'node:path';

const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 60_000;
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 300_000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;

function integerFromEnv(env, name, fallback, { min, max } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} must be <= ${max}`);
  }

  return value;
}

function stringFromEnv(env, name, fallback = '') {
  const value = env[name];
  return value === undefined ? fallback : value.trim();
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const port = integerFromEnv(env, 'PORT', 8080, { min: 1, max: 65_535 });
  const dataFile = stringFromEnv(env, 'DATA_FILE', resolve(cwd, 'data', 'incidents.json'));
  const databaseUrl = stringFromEnv(env, 'DATABASE_URL');

  return Object.freeze({
    adminToken: stringFromEnv(env, 'ADMIN_TOKEN'),
    appVersion: stringFromEnv(env, 'APP_VERSION', 'local'),
    authRateLimitMax: integerFromEnv(env, 'AUTH_RATE_LIMIT_MAX', DEFAULT_AUTH_RATE_LIMIT_MAX, { min: 1 }),
    authRateLimitWindowMs: integerFromEnv(env, 'AUTH_RATE_LIMIT_WINDOW_MS', DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS, { min: 1 }),
    dataFile,
    databaseSsl: stringFromEnv(env, 'DATABASE_SSL', 'true').toLowerCase() !== 'false',
    databaseUrl,
    environment: stringFromEnv(env, 'NODE_ENV', 'development'),
    logLevel: stringFromEnv(env, 'LOG_LEVEL', 'info').toLowerCase(),
    port,
    rateLimitMax: integerFromEnv(env, 'RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX, { min: 1 }),
    rateLimitWindowMs: integerFromEnv(env, 'RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT_WINDOW_MS, { min: 1 })
  });
}
