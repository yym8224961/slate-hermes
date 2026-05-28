import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import {
  AppError,
  AuthError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../errors';
import { mapPrismaError } from '../errors/prisma-error.map';
import { currentRequestId } from '../request-context';

interface ErrorEnvelope {
  error: string;
  message: string;
  detail?: unknown;
  requestId?: string;
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const appErr = this.normalize(exception);
    const envelope: ErrorEnvelope = {
      error: appErr.code,
      message: appErr.message,
      requestId: currentRequestId(),
    };

    if (appErr.httpStatus >= 500) {
      this.logger.error({ err: exception, requestId: envelope.requestId }, appErr.message);
    } else if (appErr.detail !== undefined) {
      envelope.detail = appErr.detail;
    }

    const retryAfterSec = retryAfterFromDetail(appErr.detail);
    if (appErr instanceof RateLimitedError && retryAfterSec !== null) {
      reply.header('Retry-After', String(retryAfterSec));
    }

    void reply.status(appErr.httpStatus).send(envelope);
  }

  private normalize(exception: unknown): AppError {
    if (exception instanceof AppError) return exception;

    if (exception instanceof ZodError) {
      return new ValidationError('请求参数验证失败', {
        issues: exception.issues,
      });
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return mapPrismaError(exception);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string }).message ?? exception.message);
      const detail = typeof res === 'object' ? res : undefined;
      const code =
        typeof res === 'object' && res && typeof (res as { error?: unknown }).error === 'string'
          ? (res as { error: string }).error
          : 'http_error';
      switch (status) {
        case 400:
          return new ValidationError(message, detail);
        case 401:
          return new AuthError(message, detail);
        case 403:
          return new ForbiddenError(message, detail);
        case 404:
          return new NotFoundError(message, detail);
        case 409:
          return new ConflictError(message, detail);
        case 429:
          return new RateLimitedError(message, detail);
        default:
          return status >= 400 && status < 500
            ? new HttpAppError(status, code, message, detail)
            : new InternalError(message, detail);
      }
    }

    if (exception instanceof Error) {
      return new InternalError(exception.message);
    }
    return new InternalError('服务器内部错误');
  }
}

class HttpAppError extends AppError {
  readonly httpStatus: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message, detail);
    this.httpStatus = status;
    this.code = code;
  }
}

function retryAfterFromDetail(detail: unknown): number | null {
  if (!detail || typeof detail !== 'object') return null;
  const value = (detail as { retry_after_sec?: unknown }).retry_after_sec;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(Math.ceil(value), 1);
}
