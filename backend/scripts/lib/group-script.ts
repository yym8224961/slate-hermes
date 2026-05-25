import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { PrismaService } from '../../src/infra/prisma/prisma.service';
import type { ContentsService } from '../../src/modules/contents/contents.service';
import type { GroupsService } from '../../src/modules/groups/groups.service';

export interface UserSelectorArgs {
  userId?: string;
  email?: string;
  username?: string;
}

export interface ResolvedScriptUser {
  id: string;
  email: string;
  username: string | null;
}

export interface GroupScriptServices {
  app: INestApplicationContext;
  prisma: PrismaService;
  groups: GroupsService;
  contents: ContentsService;
}

export async function createGroupScriptServices(): Promise<GroupScriptServices> {
  process.env.BACKGROUND_WORKERS = 'false';
  const [{ AppModule }, { PrismaService }, { GroupsService }, { ContentsService }] =
    await Promise.all([
      import('../../src/app.module'),
      import('../../src/infra/prisma/prisma.service'),
      import('../../src/modules/groups/groups.service'),
      import('../../src/modules/contents/contents.service'),
    ]);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  return {
    app,
    prisma: app.get(PrismaService),
    groups: app.get(GroupsService),
    contents: app.get(ContentsService),
  };
}

export function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function userDisplay(user: ResolvedScriptUser): string {
  return `${user.email}${user.username ? ` (${user.username})` : ''}`;
}

export async function resolveUser(
  prisma: PrismaService,
  args: UserSelectorArgs
): Promise<ResolvedScriptUser> {
  const where =
    args.userId !== undefined
      ? { id: args.userId }
      : args.email !== undefined
        ? { email: args.email }
        : args.username !== undefined
          ? { username: args.username }
          : undefined;

  if (where) {
    const user = await prisma.user.findFirst({
      where,
      select: { id: true, email: true, username: true },
    });
    if (!user) throw new Error('No matching user found.');
    return user;
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, username: true },
  });
  if (users.length === 1) return users[0]!;
  if (users.length === 0) throw new Error('No users found. Create an account first.');
  throw new Error(
    [
      'Multiple users found. Pass --email, --username, or --user-id.',
      ...users.map((u) => `  ${u.email}${u.username ? ` (${u.username})` : ''} id=${u.id}`),
    ].join('\n')
  );
}

export async function ensureGroup(
  groups: GroupsService,
  prisma: PrismaService,
  userId: string,
  groupName: string
): Promise<{ id: string; name: string }> {
  const existing = await prisma.group.findFirst({
    where: { ownerUserId: userId, name: groupName },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true },
  });
  if (existing) return existing;
  const created = await groups.create(userId, { name: groupName });
  return { id: created.id, name: created.name };
}

export async function deleteAllContents(
  contents: ContentsService,
  groupId: string,
  userId: string
): Promise<void> {
  const rows = await contents.list(groupId, { userId });
  for (const row of rows) {
    await contents.delete(row.id, userId);
  }
}
