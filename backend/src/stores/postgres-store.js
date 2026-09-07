import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../errors.js';
import { createSeedIncidents } from '../seed.js';

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'resolved')),
  owner TEXT NOT NULL DEFAULT 'unassigned',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents(status);
CREATE INDEX IF NOT EXISTS incidents_priority_idx ON incidents(priority);
CREATE INDEX IF NOT EXISTS incidents_updated_at_idx ON incidents(updated_at DESC);
`;

function toIncident(row) {
  return {
    createdAt: new Date(row.created_at).toISOString(),
    description: row.description,
    id: row.id,
    owner: row.owner,
    priority: row.priority,
    status: row.status,
    title: row.title,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function appendFilter(filters, clauses, values, column, value) {
  if (!value) {
    return;
  }

  values.push(value);
  clauses.push(`${column} = $${values.length}`);
}

export class PostgresIncidentStore {
  constructor({ connectionString, ssl = true }) {
    this.connectionString = connectionString;
    this.ssl = ssl;
    this.pool = null;
  }

  async init() {
    const pg = await import('pg');
    const { Pool } = pg.default ?? pg;

    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 10,
      ssl: this.ssl ? { rejectUnauthorized: false } : false
    });

    await this.pool.query(CREATE_TABLE_SQL);
    await this.seedIfEmpty();
  }

  async seedIfEmpty() {
    const result = await this.pool.query('SELECT count(*)::int AS count FROM incidents');
    if (result.rows[0].count > 0) {
      return;
    }

    const seedIncidents = createSeedIncidents();
    await this.pool.query('BEGIN');
    try {
      for (const incident of seedIncidents) {
        await this.pool.query(
          `INSERT INTO incidents (id, title, description, priority, status, owner, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING`,
          [
            incident.id,
            incident.title,
            incident.description,
            incident.priority,
            incident.status,
            incident.owner,
            incident.createdAt,
            incident.updatedAt
          ]
        );
      }
      await this.pool.query('COMMIT');
    } catch (error) {
      await this.pool.query('ROLLBACK');
      throw error;
    }
  }

  async list(filters = {}) {
    const clauses = [];
    const values = [];

    appendFilter(filters, clauses, values, 'status', filters.status);
    appendFilter(filters, clauses, values, 'priority', filters.priority);

    if (filters.q) {
      values.push(`%${filters.q.toLowerCase()}%`);
      clauses.push(`(lower(title) LIKE $${values.length} OR lower(description) LIKE $${values.length} OR lower(owner) LIKE $${values.length})`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT id, title, description, priority, status, owner, created_at, updated_at
       FROM incidents
       ${where}
       ORDER BY updated_at DESC
       LIMIT 200`,
      values
    );

    return result.rows.map(toIncident);
  }

  async create(input) {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO incidents (id, title, description, priority, status, owner)
       VALUES ($1, $2, $3, $4, 'open', $5)
       RETURNING id, title, description, priority, status, owner, created_at, updated_at`,
      [id, input.title, input.description, input.priority, input.owner]
    );

    return toIncident(result.rows[0]);
  }

  async updateStatus(id, status) {
    const result = await this.pool.query(
      `UPDATE incidents
       SET status = $2, updated_at = now()
       WHERE id = $1
       RETURNING id, title, description, priority, status, owner, created_at, updated_at`,
      [id, status]
    );

    if (result.rowCount === 0) {
      throw new NotFoundError('Incident');
    }

    return toIncident(result.rows[0]);
  }

  async remove(id) {
    const result = await this.pool.query('DELETE FROM incidents WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      throw new NotFoundError('Incident');
    }
  }

  async stats() {
    const [statusResult, priorityResult, totalResult, openCriticalResult] = await Promise.all([
      this.pool.query('SELECT status, count(*)::int AS count FROM incidents GROUP BY status'),
      this.pool.query('SELECT priority, count(*)::int AS count FROM incidents GROUP BY priority'),
      this.pool.query('SELECT count(*)::int AS count FROM incidents'),
      this.pool.query("SELECT count(*)::int AS count FROM incidents WHERE status <> 'resolved' AND priority = 'critical'")
    ]);

    return {
      byPriority: Object.fromEntries(priorityResult.rows.map((row) => [row.priority, row.count])),
      byStatus: Object.fromEntries(statusResult.rows.map((row) => [row.status, row.count])),
      openCritical: openCriticalResult.rows[0].count,
      total: totalResult.rows[0].count
    };
  }

  async ready() {
    await this.pool.query('SELECT 1');
    return { ok: true, store: 'postgres' };
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
    }
  }
}
