import assert from 'node:assert/strict';
import test from 'node:test';

import { startTestServer } from './helpers.js';

test('health, readiness, API flow, and metrics work', async () => {
  const server = await startTestServer();

  try {
    const health = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(health.status, 200);

    const ready = await fetch(`${server.baseUrl}/readyz`);
    assert.equal(ready.status, 200);

    const openApi = await fetch(`${server.baseUrl}/openapi.yaml`);
    assert.equal(openApi.status, 200);
    assert.match(await openApi.text(), /openapi: 3\.1\.0/);

    const missingAsset = await fetch(`${server.baseUrl}/favicon.ico`);
    assert.equal(missingAsset.status, 404);

    const created = await fetch(`${server.baseUrl}/api/incidents`, {
      body: JSON.stringify({
        description: 'Synthetic test incident',
        owner: 'qa',
        priority: 'critical',
        title: 'Synthetic test'
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    assert.equal(created.status, 201);
    const createdPayload = await created.json();

    const patched = await fetch(`${server.baseUrl}/api/incidents/${createdPayload.incident.id}/status`, {
      body: JSON.stringify({ status: 'resolved' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH'
    });
    assert.equal(patched.status, 200);

    const list = await fetch(`${server.baseUrl}/api/incidents?q=synthetic`);
    const listPayload = await list.json();
    assert.equal(listPayload.incidents.length, 1);
    assert.equal(listPayload.incidents[0].status, 'resolved');

    const deleted = await fetch(`${server.baseUrl}/api/incidents/${createdPayload.incident.id}`, {
      method: 'DELETE'
    });
    assert.equal(deleted.status, 204);

    const listAfterDelete = await fetch(`${server.baseUrl}/api/incidents?q=synthetic`);
    const listAfterDeletePayload = await listAfterDelete.json();
    assert.equal(listAfterDeletePayload.incidents.length, 0);

    const deleteMissing = await fetch(`${server.baseUrl}/api/incidents/${createdPayload.incident.id}`, {
      method: 'DELETE'
    });
    assert.equal(deleteMissing.status, 404);

    const metrics = await fetch(`${server.baseUrl}/metrics`);
    assert.match(await metrics.text(), /opsboard_http_requests_total/);
  } finally {
    await server.close();
  }
});

test('write endpoints require bearer token when ADMIN_TOKEN is configured', async () => {
  const server = await startTestServer({ adminToken: 'secret' });

  try {
    const blocked = await fetch(`${server.baseUrl}/api/incidents`, {
      body: JSON.stringify({ title: 'Blocked test' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    assert.equal(blocked.status, 401);

    const allowed = await fetch(`${server.baseUrl}/api/incidents`, {
      body: JSON.stringify({ priority: 'low', title: 'Allowed test' }),
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      method: 'POST'
    });
    assert.equal(allowed.status, 201);
    const allowedPayload = await allowed.json();

    const blockedDelete = await fetch(`${server.baseUrl}/api/incidents/${allowedPayload.incident.id}`, {
      method: 'DELETE'
    });
    assert.equal(blockedDelete.status, 401);

    const allowedDelete = await fetch(`${server.baseUrl}/api/incidents/${allowedPayload.incident.id}`, {
      headers: { Authorization: 'Bearer secret' },
      method: 'DELETE'
    });
    assert.equal(allowedDelete.status, 204);
  } finally {
    await server.close();
  }
});

test('repeated failed bearer tokens are rate limited to block brute-forcing', async () => {
  const server = await startTestServer({
    adminToken: 'secret',
    authRateLimitMax: 3,
    authRateLimitWindowMs: 60_000
  });

  try {
    let lastStatus;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${server.baseUrl}/api/incidents`, {
        body: JSON.stringify({ title: 'Guess attempt' }),
        headers: {
          Authorization: `Bearer wrong-${attempt}`,
          'Content-Type': 'application/json'
        },
        method: 'POST'
      });
      lastStatus = response.status;
    }
    assert.equal(lastStatus, 429);

    const stillWorksWithCorrectToken = await fetch(`${server.baseUrl}/api/incidents`, {
      body: JSON.stringify({ priority: 'low', title: 'Correct token is not penalized' }),
      headers: {
        Authorization: 'Bearer secret',
        'Content-Type': 'application/json'
      },
      method: 'POST'
    });
    assert.equal(stillWorksWithCorrectToken.status, 201);
  } finally {
    await server.close();
  }
});
