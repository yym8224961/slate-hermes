import { randomUUID } from 'node:crypto';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
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
} from '../../errors';
import { mapPrismaError } from '../../errors/prisma-error.map';
import { currentRequestId } from '../../http/request-context';
import { safeRequestId } from '../../http/request-id';

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
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    if (shouldIgnoreAbortError(exception, reply)) return;

    const appErr = this.normalize(exception);
    const requestId = requestIdFor(req);
    const envelope: ErrorEnvelope = {
      error: appErr.code,
      message: appErr.httpStatus >= 500 ? '服务器内部错误' : appErr.message,
      requestId,
    };

    if (!reply.raw.headersSent) void reply.header('x-request-id', requestId);

    if (appErr.httpStatus >= 500) {
      const errForLog = exception instanceof Error ? exception : appErr;
      (reply.raw as ErrorAwareReplyRaw).err = errForLog;
      this.logger.error(
        errorLogFields(req, appErr, errForLog, requestId, exception),
        `${req.method} ${req.url} failed: ${appErr.message}`
      );
    } else if (appErr.detail !== undefined) {
      // Client-safe AppError details are part of the API contract for 4xx responses.
      // 5xx details are intentionally withheld above to avoid leaking internals.
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
      const detail = httpExceptionDetail(res);
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

type ErrorAwareReplyRaw = FastifyReply['raw'] & { err?: Error };

class HttpAppError extends AppError {
  readonly httpStatus: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message, detail);
    this.httpStatus = status;
    this.code = code;
  }
}

function httpExceptionDetail(response: unknown): Record<string, unknown> | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const source = response as Record<string, unknown>;
  const detail: Record<string, unknown> = {};
  if (typeof source.error === 'string') detail.error = source.error;
  if (typeof source.message === 'string' || Array.isArray(source.message)) {
    detail.message = source.message;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}

function retryAfterFromDetail(detail: unknown): number | null {
  if (!detail || typeof detail !== 'object') return null;
  const value = (detail as { retry_after_sec?: unknown }).retry_after_sec;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(Math.ceil(value), 1);
}

function requestIdFor(req: FastifyRequest): string {
  const requestId =
    currentRequestId() ?? safeRequestId(req.headers['x-request-id']) ?? safeRequestId(req.id);
  if (requestId) return requestId;
  const created = randomUUID();
  req.id = created;
  return created;
}

function errorLogFields(
  req: FastifyRequest,
  appErr: AppError,
  err: Error,
  requestId: string,
  thrown: unknown
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    err,
    requestId,
    method: req.method,
    url: req.url,
    statusCode: appErr.httpStatus,
    errorCode: appErr.code,
  };
  if (appErr.detail !== undefined) fields.detail = summarizeLogValue(appErr.detail);
  if (!(thrown instanceof Error)) fields.thrown = summarizeLogValue(thrown);
  return fields;
}

function shouldIgnoreAbortError(err: unknown, reply: FastifyReply): boolean {
  if (!isAbortError(err)) return false;
  const raw = reply.raw as FastifyReply['raw'] & {
    closed?: boolean;
    writableDestroyed?: boolean;
  };
  return (
    reply.sent ||
    raw.writableEnded ||
    raw.destroyed ||
    raw.writableDestroyed === true ||
    raw.closed === true
  );
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError';
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

const LOG_VALUE_MAX_DEPTH = 3;
const LOG_VALUE_MAX_ARRAY_ITEMS = 8;
const LOG_VALUE_MAX_OBJECT_KEYS = 16;
const LOG_VALUE_MAX_STRING_CHARS = 512;
const SENSITIVE_LOG_KEY_RE = /(?:authorization|cookie|password|secret|token|api[_-]?key)$/i;

function summarizeLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return summarizeLogString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: summarizeLogString(value.message),
    };
  }

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (depth >= LOG_VALUE_MAX_DEPTH) {
    return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, LOG_VALUE_MAX_ARRAY_ITEMS)
      .map((item) => summarizeLogValue(item, depth + 1, seen));
    if (value.length > LOG_VALUE_MAX_ARRAY_ITEMS) {
      items.push(`... ${value.length - LOG_VALUE_MAX_ARRAY_ITEMS} more item(s)`);
    }
    return items;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entryValue] of entries.slice(0, LOG_VALUE_MAX_OBJECT_KEYS)) {
    output[key] = SENSITIVE_LOG_KEY_RE.test(key)
      ? '[Redacted]'
      : summarizeLogValue(entryValue, depth + 1, seen);
  }
  if (entries.length > LOG_VALUE_MAX_OBJECT_KEYS) {
    output._truncated_keys = entries.length - LOG_VALUE_MAX_OBJECT_KEYS;
  }
  return output;
}

function summarizeLogString(value: string): string {
  if (value.length <= LOG_VALUE_MAX_STRING_CHARS) return value;
  return `${value.slice(0, LOG_VALUE_MAX_STRING_CHARS)}... [truncated ${value.length - LOG_VALUE_MAX_STRING_CHARS} chars]`;
}
