import { Prisma } from '@prisma/client';
import { AppError } from './app-error';
import { ConflictError, InternalError, NotFoundError, ValidationError } from './errors';

export function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): AppError {
  switch (err.code) {
    case 'P2002':
      return new ConflictError('数据已存在', { code: 'unique_constraint_violation' });
    case 'P2003':
      return new ValidationError('关联记录不存在或仍被引用', {
        code: 'foreign_key_constraint_violation',
      });
    case 'P2025':
      return new NotFoundError('记录不存在', { code: 'record_not_found' });
    default:
      return new InternalError(`prisma ${err.code}`, { meta: err.meta });
  }
}
