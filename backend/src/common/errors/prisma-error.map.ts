import { Prisma } from '@prisma/client';
import { AppError, ConflictError, InternalError, NotFoundError } from './index';

export function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): AppError {
  switch (err.code) {
    case 'P2002':
      return new ConflictError('unique constraint violation', { meta: err.meta });
    case 'P2025':
      return new NotFoundError('record not found', { meta: err.meta });
    default:
      return new InternalError(`prisma ${err.code}`, { meta: err.meta });
  }
}
