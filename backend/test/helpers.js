import { once } from 'node:events';

import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { FileIncidentStore } from '../src/stores/file-store.js';

export async function startTestServer(overrides = {}) {
  const config = {
    adminToken: '',
    appVersion: 'test',
    authRateLimitMax: 10_000,
    authRateLimitWindowMs: 60_000,
    dataFile: ':memory:',
    databaseUrl: '',
    environment: 'test',
    logLevel: 'error',
    port: 0,
    rateLimitMax: 10_000,
    rateLimitWindowMs: 60_000,
    ...overrides
  };
  const store = new FileIncidentStore({ filePath: config.dataFile });
  await store.init();

  const server = createApp({
    config,
    logger: createLogger({ level: config.logLevel }),
    store
  });

  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () => {
      server.close();
      await once(server, 'close');
      await store.close();
    },
    store
  };
}
