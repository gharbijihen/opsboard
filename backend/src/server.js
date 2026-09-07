import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { createIncidentStore } from './store.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const store = await createIncidentStore(config);

await store.init();

const server = createApp({ config, logger, store });

server.listen(config.port, () => {
  logger.info('server started', {
    environment: config.environment,
    port: config.port,
    store: config.databaseUrl ? 'postgres' : config.dataFile === ':memory:' ? 'memory' : 'file',
    version: config.appVersion
  });
});

async function shutdown(signal) {
  logger.info('shutdown requested', { signal });
  server.close(async () => {
    await store.close();
    logger.info('shutdown complete');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('shutdown timed out');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
