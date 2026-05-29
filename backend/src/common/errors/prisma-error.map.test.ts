import { describe, expect, it } from 'bun:test';
import { Prisma } from '@prisma/client';
import { mapPrismaError } from './prisma-error.map';

describe('mapPrismaError', () => {
  it('does not expose Prisma unique constraint metadata in 4xx details', () => {
    const err = new Prisma.PrismaClientKnownRequestError('unique failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['email'] },
    });

    const mapped = mapPrismaError(err);

    expect(mapped.httpStatus).toBe(409);
    expect(mapped.detail).toEqual({ code: 'unique_constraint_violation' });
  });

  it('maps foreign key violations to a client error', () => {
    const err = new Prisma.PrismaClientKnownRequestError('foreign key failed', {
      code: 'P2003',
      clientVersion: 'test',
      meta: { field_name: 'groupId' },
    });

    const mapped = mapPrismaError(err);

    expect(mapped.httpStatus).toBe(400);
    expect(mapped.detail).toEqual({ code: 'foreign_key_constraint_violation' });
  });
});
