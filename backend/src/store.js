import { FileIncidentStore } from './stores/file-store.js';

export async function createIncidentStore(config) {
  if (!config.databaseUrl) {
    return new FileIncidentStore({ filePath: config.dataFile });
  }

  try {
    const { PostgresIncidentStore } = await import('./stores/postgres-store.js');
    return new PostgresIncidentStore({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl
    });
  } catch (error) {
    const message = error.code === 'ERR_MODULE_NOT_FOUND'
      ? 'DATABASE_URL is set, but optional dependency "pg" is not installed. Run npm install before using PostgreSQL.'
      : error.message;
    throw new Error(message);
  }
}
