import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { FileIncidentStore } from '../src/stores/file-store.js';

test('file store creates, filters, updates, and persists incidents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opsboard-'));
  const filePath = join(dir, 'incidents.json');

  try {
    const store = new FileIncidentStore({ filePath });
    await store.init();

    const incident = await store.create({
      description: 'The API is returning intermittent 500s.',
      owner: 'backend',
      priority: 'high',
      title: 'API error rate elevated'
    });

    assert.equal(incident.status, 'open');
    assert.equal(incident.priority, 'high');

    const filtered = await store.list({ priority: 'high' });
    assert.equal(filtered.some((item) => item.id === incident.id), true);

    const updated = await store.updateStatus(incident.id, 'in_progress');
    assert.equal(updated.status, 'in_progress');

    const reopened = new FileIncidentStore({ filePath });
    await reopened.init();
    const persisted = await reopened.list({ q: 'intermittent' });
    assert.equal(persisted.some((item) => item.id === incident.id), true);

    await reopened.remove(incident.id);
    const afterRemove = await reopened.list({ q: 'intermittent' });
    assert.equal(afterRemove.some((item) => item.id === incident.id), false);

    await assert.rejects(() => reopened.remove(incident.id), { name: 'NotFoundError' });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
