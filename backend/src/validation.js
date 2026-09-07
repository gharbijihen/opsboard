import { ValidationError } from './errors.js';

export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const STATUSES = ['open', 'in_progress', 'resolved'];

function cleanText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function hasAllowedValue(value, allowed) {
  return allowed.includes(String(value ?? '').toLowerCase());
}

export function validateCreateIncident(input) {
  const body = input && typeof input === 'object' ? input : {};
  const errors = {};

  const title = cleanText(body.title);
  const description = cleanText(body.description);
  const owner = cleanText(body.owner) || 'unassigned';
  const priority = String(body.priority ?? 'medium').toLowerCase();

  if (title.length < 3 || title.length > 120) {
    errors.title = 'Title must be between 3 and 120 characters';
  }
  if (description.length > 1_000) {
    errors.description = 'Description must be 1000 characters or less';
  }
  if (owner.length > 80) {
    errors.owner = 'Owner must be 80 characters or less';
  }
  if (!hasAllowedValue(priority, PRIORITIES)) {
    errors.priority = `Priority must be one of: ${PRIORITIES.join(', ')}`;
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors);
  }

  return {
    description,
    owner,
    priority,
    title
  };
}

export function validateStatusUpdate(input) {
  const body = input && typeof input === 'object' ? input : {};
  const status = String(body.status ?? '').toLowerCase();

  if (!hasAllowedValue(status, STATUSES)) {
    throw new ValidationError({
      status: `Status must be one of: ${STATUSES.join(', ')}`
    });
  }

  return { status };
}

export function normalizeIncidentFilters(searchParams) {
  const status = String(searchParams.get('status') ?? '').toLowerCase();
  const priority = String(searchParams.get('priority') ?? '').toLowerCase();
  const q = cleanText(searchParams.get('q'));
  const errors = {};

  if (status && !hasAllowedValue(status, STATUSES)) {
    errors.status = `Status must be one of: ${STATUSES.join(', ')}`;
  }
  if (priority && !hasAllowedValue(priority, PRIORITIES)) {
    errors.priority = `Priority must be one of: ${PRIORITIES.join(', ')}`;
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors);
  }

  return {
    priority: priority || undefined,
    q: q || undefined,
    status: status || undefined
  };
}
