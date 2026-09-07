import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeIncidentFilters, validateCreateIncident, validateStatusUpdate } from '../src/validation.js';

test('validateCreateIncident normalizes a valid payload', () => {
  const payload = validateCreateIncident({
    description: '  A   useful detail ',
    owner: '',
    priority: 'HIGH',
    title: '  API outage  '
  });

  assert.deepEqual(payload, {
    description: 'A useful detail',
    owner: 'unassigned',
    priority: 'high',
    title: 'API outage'
  });
});

test('validateCreateIncident rejects invalid fields', () => {
  assert.throws(
    () => validateCreateIncident({ priority: 'urgent', title: 'no' }),
    /Request validation failed/
  );
});

test('validateStatusUpdate allows known status values', () => {
  assert.deepEqual(validateStatusUpdate({ status: 'RESOLVED' }), { status: 'resolved' });
});

test('normalizeIncidentFilters rejects unknown status', () => {
  const params = new URLSearchParams({ status: 'waiting' });
  assert.throws(() => normalizeIncidentFilters(params), /Request validation failed/);
});
