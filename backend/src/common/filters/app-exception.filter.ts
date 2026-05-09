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
      detail: appErr.detail,
      requestId: currentRequestId(),
    };

    if (appErr.httpStatus >= 500) {
      this.logger.error({ err: exception, requestId: envelope.requestId }, appErr.message);
    }

    void reply.status(appErr.httpStatus).send(envelope);
  }

  private normalize(exception: unknown): AppError {
    if (exception instanceof AppError) return exception;

    if (exception instanceof ZodError) {
      return new ValidationError('request validation failed', {
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
        default:
          return new InternalError(message, detail);
      }
    }

    if (exception instanceof Error) {
      return new InternalError(exception.message);
    }
    return new InternalError('unknown error');
  }
}
