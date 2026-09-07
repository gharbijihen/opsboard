import assert from 'node:assert/strict';
import test from 'node:test';

import { startTestServer } from './helpers.js';

test('browser entrypoint and API support the critical user journey', async () => {
  const server = await startTestServer();

  try {
    const root = await fetch(server.baseUrl);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /OpsBoard/);

    const createResponse = await fetch(`${server.baseUrl}/api/incidents`, {
      body: JSON.stringify({
        description: 'End-to-end smoke test',
        owner: 'release',
        priority: 'medium',
        title: 'Release smoke test'
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    assert.equal(createResponse.status, 201);

    const statsResponse = await fetch(`${server.baseUrl}/api/stats`);
    const statsPayload = await statsResponse.json();
    assert.equal(statsPayload.stats.total >= 1, true);
  } finally {
    await server.close();
  }
});
