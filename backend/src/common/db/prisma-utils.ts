import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../infra/prisma/prisma.service';

export type PrismaClientLike = Prisma.TransactionClient | PrismaService;

export function prismaUniqueTargetIncludes(
  err: Prisma.PrismaClientKnownRequestError,
  ...fields: string[]
): boolean {
  if (err.code !== 'P2002') return false;
  const target = err.meta?.target;
  if (Array.isArray(target)) {
    return fields.every((field) => target.includes(field));
  }
  if (typeof target === 'string') {
    return fields.every((field) => target.includes(field));
  }
  return false;
}
