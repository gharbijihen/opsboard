export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends ApiError {
  constructor(details) {
    super(400, 'VALIDATION_ERROR', 'Request validation failed', details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends ApiError {
  constructor(resourceName) {
    super(404, 'NOT_FOUND', `${resourceName} was not found`);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor() {
    super(401, 'UNAUTHORIZED', 'A valid bearer token is required');
    this.name = 'UnauthorizedError';
  }
}

export class TooManyRequestsError extends ApiError {
  constructor() {
    super(429, 'RATE_LIMITED', 'Too many requests');
    this.name = 'TooManyRequestsError';
  }
}
