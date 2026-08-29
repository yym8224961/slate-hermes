import { describe, expect, it } from 'bun:test';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { ForbiddenError, ValidationError } from '../../common/errors';
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

describe('UsersService.createInitialAdmin', () => {
  it('creates the first account as the administrator', async () => {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          user: {
            findFirst: async () => null,
            create: async ({ data }: { data: Record<string, unknown> }) => {
              created.push(data);
              return { id: 'admin-1', email: data.email, username: data.username };
            },
          },
        }),
    } as unknown as PrismaService;
    const service = new UsersService(prisma);

    await service.createInitialAdmin('admin@example.com', 'admin', 'password123');

    expect(created).toHaveLength(1);
    expect(created[0]?.['isAdmin']).toBe(true);
  });

  it('rejects public registration after an account already exists', async () => {
    let creates = 0;
    const prisma = {
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          user: {
            findFirst: async () => ({ id: 'existing-user' }),
            create: async () => {
              creates += 1;
            },
          },
        }),
    } as unknown as PrismaService;
    const service = new UsersService(prisma);

    await expect(
      service.createInitialAdmin('attacker@example.com', 'attacker', 'password123')
    ).rejects.toThrow(ForbiddenError);
    expect(creates).toBe(0);
  });
});
