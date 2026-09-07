import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../errors.js';
import { createSeedIncidents } from '../seed.js';

function cloneIncident(incident) {
  return { ...incident };
}

function matchesFilters(incident, filters) {
  if (filters.status && incident.status !== filters.status) {
    return false;
  }
  if (filters.priority && incident.priority !== filters.priority) {
    return false;
  }
  if (filters.q) {
    const haystack = `${incident.title} ${incident.description} ${incident.owner}`.toLowerCase();
    return haystack.includes(filters.q.toLowerCase());
  }
  return true;
}

function buildStats(items) {
  const byPriority = {};
  const byStatus = {};

  for (const incident of items) {
    byPriority[incident.priority] = (byPriority[incident.priority] ?? 0) + 1;
    byStatus[incident.status] = (byStatus[incident.status] ?? 0) + 1;
  }

  return {
    byPriority,
    byStatus,
    openCritical: items.filter((incident) => incident.status !== 'resolved' && incident.priority === 'critical').length,
    total: items.length
  };
}

export class FileIncidentStore {
  constructor({ filePath, clock = () => new Date() }) {
    this.clock = clock;
    this.filePath = filePath;
    this.items = [];
    this.memoryOnly = filePath === ':memory:';
    this.writeQueue = Promise.resolve();
  }

  async init() {
    if (this.memoryOnly) {
      this.items = createSeedIncidents(this.clock());
      return;
    }

    await mkdir(dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.items = Array.isArray(parsed.incidents) ? parsed.incidents : [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      this.items = createSeedIncidents(this.clock());
      await this.persist();
    }
  }

  async list(filters = {}) {
    return this.items
      .filter((incident) => matchesFilters(incident, filters))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(cloneIncident);
  }

  async create(input) {
    const now = this.clock().toISOString();
    const incident = {
      createdAt: now,
      description: input.description,
      id: randomUUID(),
      owner: input.owner,
      priority: input.priority,
      status: 'open',
      title: input.title,
      updatedAt: now
    };

    this.items.unshift(incident);
    await this.persist();
    return cloneIncident(incident);
  }

  async updateStatus(id, status) {
    const incident = this.items.find((item) => item.id === id);
    if (!incident) {
      throw new NotFoundError('Incident');
    }

    incident.status = status;
    incident.updatedAt = this.clock().toISOString();
    await this.persist();
    return cloneIncident(incident);
  }

  async remove(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new NotFoundError('Incident');
    }

    this.items.splice(index, 1);
    await this.persist();
  }

  async stats() {
    return buildStats(this.items);
  }

  async ready() {
    if (this.memoryOnly) {
      return { ok: true, store: 'memory' };
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    await this.persist();
    return { ok: true, store: 'file' };
  }

  async persist() {
    if (this.memoryOnly) {
      return;
    }

    const payload = `${JSON.stringify({ incidents: this.items }, null, 2)}\n`;
    const tempPath = `${this.filePath}.tmp`;

    this.writeQueue = this.writeQueue.then(async () => {
      await writeFile(tempPath, payload, 'utf8');
      await rename(tempPath, this.filePath);
    });

    return this.writeQueue;
  }

  async close() {
  }
}
