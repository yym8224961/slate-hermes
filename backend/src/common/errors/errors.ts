import { AppError } from './app-error';

export class ValidationError extends AppError {
  readonly code = 'validation_error';
  readonly httpStatus = 400;
}

export class AuthError extends AppError {
  readonly code = 'unauthorized';
  readonly httpStatus = 401;
}

export class ForbiddenError extends AppError {
  readonly code = 'forbidden';
  readonly httpStatus = 403;
}

export class NotFoundError extends AppError {
  readonly code = 'not_found';
  readonly httpStatus = 404;
}

export class ConflictError extends AppError {
  readonly code = 'conflict';
  readonly httpStatus = 409;
}

export class RateLimitedError extends AppError {
  readonly code = 'rate_limited';
  readonly httpStatus = 429;
}

export class NotImplementedError extends AppError {
  readonly code = 'not_implemented';
  readonly httpStatus = 501;
}

export class InternalError extends AppError {
  readonly code = 'internal_server_error';
  readonly httpStatus = 500;
}
