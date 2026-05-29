import { describe, expect, it } from 'bun:test';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { ValidationError } from '../../common/errors';
import { UsersService } from './users.service';

describe('UsersService.findByIdentifier', () => {
  it('does not fall back to username lookup when the identifier is an email', async () => {
    const calls: string[] = [];
    const prisma = {
      user: {
        findUnique: async ({ where }: { where: { email?: string; username?: string } }) => {
          calls.push(where.email ? `email:${where.email}` : `username:${where.username}`);
          return null;
        },
      },
    } as unknown as PrismaService;
    const service = new UsersService(prisma);

    await service.findByIdentifier('someone@example.com');

    expect(calls).toEqual(['email:someone@example.com']);
  });

  it('keeps legacy short email identifiers on the email lookup path', async () => {
    const calls: string[] = [];
    const prisma = {
      user: {
        findUnique: async ({ where }: { where: { email?: string; username?: string } }) => {
          calls.push(where.email ? `email:${where.email}` : `username:${where.username}`);
          return null;
        },
      },
    } as unknown as PrismaService;
    const service = new UsersService(prisma);

    await service.findByIdentifier('a@b.c');

    expect(calls).toEqual(['email:a@b.c']);
  });

  it('trims identifiers and rejects empty values before querying', async () => {
    let calls = 0;
    const prisma = {
      user: {
        findUnique: async () => {
          calls += 1;
          return null;
        },
      },
    } as unknown as PrismaService;
    const service = new UsersService(prisma);

    await expect(service.findByIdentifier('   ')).rejects.toThrow(ValidationError);
    expect(calls).toBe(0);
  });
});
