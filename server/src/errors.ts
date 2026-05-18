/**
 * Domain error classes.
 *
 * Each carries a stable `code` that gets surfaced in `error.extensions.code`
 * so that frontends and tests can branch on machine-readable values instead
 * of brittle string matching against the human message.
 */
export type ErrorCode =
  | 'BAD_USER_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SEAT_HELD_BY_OTHER'
  | 'INTERNAL_SERVER_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus = 400,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('BAD_USER_INPUT', message, 400, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string | number) {
    super('NOT_FOUND', `${resource} ${id} not found`, 404, { resource, id });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFLICT', message, 409, details);
    this.name = 'ConflictError';
  }
}

export class SeatHeldByOtherError extends AppError {
  constructor(seatIds: number[]) {
    super(
      'SEAT_HELD_BY_OTHER',
      `Seats currently held by another user: ${seatIds.join(', ')}`,
      409,
      { seatIds }
    );
    this.name = 'SeatHeldByOtherError';
  }
}
