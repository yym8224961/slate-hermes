#!/usr/bin/env bun
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  HOT_LIST_SOURCES,
  HotListConfig,
  type ContentDetailT,
  type HotListSourceIdT,
} from 'shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { ContentsService } from '../src/modules/contents/contents.service';
import { GroupsService } from '../src/modules/groups/groups.service';

interface Args {
  userId?: string;
  email?: string;
  username?: string;
  groupName: string;
  replace: boolean;
  refreshIntervalSec: number;
}

const args = parseArgs(process.argv.slice(2));
const hotListConfigs = buildHotListConfigs(args.refreshIntervalSec);
const app = await NestFactory.createApplicationContext(AppModule, {
  logger: ['error', 'warn'],
});

try {
  const prisma = app.get(PrismaService);
  const groups = app.get(GroupsService);
  const contents = app.get(ContentsService);
  const user = await resolveUser(prisma, args);
  const group = await ensureGroup(groups, prisma, user.id, args.groupName);

  if (args.replace) {
    await deleteAllContents(contents, group.id, user.id);
  } else {
    await deleteDuplicateHotLists(contents, group.id, user.id);
  }

  const generated = await upsertHotListFrames(contents, group.id, user.id, hotListConfigs);
  const finalRows = await contents.list(group.id, { userId: user.id });
  const orderedIds = orderedContentIds(finalRows);
  const { manifest_etag } = await contents.reorder(group.id, user.id, orderedIds);

  process.stdout.write(
    [
      `Hot list group ready: ${args.groupName}`,
      `  user: ${user.email}${user.username ? ` (${user.username})` : ''}`,
      `  group_id: ${group.id}`,
      `  frames: ${generated.length}`,
      `  manifest_etag: ${manifest_etag}`,
    ].join('\n') + '\n'
  );
} finally {
  await app.close();
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    groupName: '热榜',
    replace: false,
    refreshIntervalSec: 600,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--replace') {
      args.replace = true;
    } else if (arg === '--user-id') {
      args.userId = readArgValue(argv, ++i, arg);
    } else if (arg === '--email') {
      args.email = readArgValue(argv, ++i, arg);
    } else if (arg === '--username') {
      args.username = readArgValue(argv, ++i, arg);
    } else if (arg === '--group-name') {
      args.groupName = readArgValue(argv, ++i, arg);
    } else if (arg === '--refresh-interval-sec') {
      args.refreshIntervalSec = readPositiveInt(readArgValue(argv, ++i, arg), arg);
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function readPositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} requires a positive integer`);
  return n;
}

function printHelpAndExit(): never {
  process.stdout.write(`Usage:
  bun run scripts/create-hot-list-group.ts [--email <email> | --username <name> | --user-id <id>]

Options:
  --group-name <name>             Group name to create or update. Default: 热榜
  --replace                       Delete all existing contents in the target group before creating frames.
  --refresh-interval-sec <sec>    Hot-list refresh interval. Default: 600
`);
  process.exit(0);
}

async function resolveUser(
  prisma: PrismaService,
  args: Args
): Promise<{
  id: string;
  email: string;
  username: string | null;
}> {
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

async function ensureGroup(
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

async function deleteAllContents(
  contents: ContentsService,
  groupId: string,
  userId: string
): Promise<void> {
  const rows = await contents.list(groupId, { userId });
  for (const row of rows) {
    await contents.delete(row.id, userId);
  }
}

async function deleteDuplicateHotLists(
  contents: ContentsService,
  groupId: string,
  userId: string
): Promise<void> {
  const rows = await contents.list(groupId, { userId });
  const seen = new Set<HotListSourceIdT>();
  const valid = new Set<HotListSourceIdT>(HOT_LIST_SOURCES.map((source) => source.id));

  for (const row of rows) {
    if (row.dynamic_type !== 'hot_list') continue;
    const sourceId = sourceIdFromContent(row);
    if (!sourceId || !valid.has(sourceId) || seen.has(sourceId)) {
      await contents.delete(row.id, userId);
      continue;
    }
    seen.add(sourceId);
  }
}

async function upsertHotListFrames(
  contents: ContentsService,
  groupId: string,
  userId: string,
  configs: Map<HotListSourceIdT, ReturnType<typeof HotListConfig.parse>>
): Promise<Array<{ sourceId: HotListSourceIdT; contentId: string }>> {
  const rows = await contents.list(groupId, { userId });
  const bySource = new Map<HotListSourceIdT, ContentDetailT>();
  for (const row of rows) {
    if (row.dynamic_type !== 'hot_list') continue;
    const sourceId = sourceIdFromContent(row);
    if (sourceId) bySource.set(sourceId, row);
  }

  const generated: Array<{ sourceId: HotListSourceIdT; contentId: string }> = [];
  for (const source of HOT_LIST_SOURCES) {
    const config = configs.get(source.id);
    if (!config) throw new Error(`Missing hot-list config for source: ${source.id}`);
    const frameName = `${source.shortLabel}热榜`;
    const existing = bySource.get(source.id);
    if (existing) {
      await contents.patchDynamic(existing.id, userId, {
        frame_name: frameName,
        config,
      });
      generated.push({ sourceId: source.id, contentId: existing.id });
      continue;
    }

    const created = await contents.appendDynamic(groupId, userId, {
      kind: 'dynamic',
      frame_name: frameName,
      config,
    });
    generated.push({ sourceId: source.id, contentId: created.id });
  }
  return generated;
}

function buildHotListConfigs(
  refreshIntervalSec: number
): Map<HotListSourceIdT, ReturnType<typeof HotListConfig.parse>> {
  return new Map(
    HOT_LIST_SOURCES.map((source) => [
      source.id,
      HotListConfig.parse({
        type: 'hot_list',
        source: source.id,
        refresh_interval_sec: refreshIntervalSec,
      }),
    ])
  );
}

function orderedContentIds(rows: ContentDetailT[]): string[] {
  const rank = new Map<HotListSourceIdT, number>(
    HOT_LIST_SOURCES.map((source, index) => [source.id, index])
  );
  const hotRows = rows
    .filter((row) => row.dynamic_type === 'hot_list' && sourceIdFromContent(row))
    .sort((a, b) => rank.get(sourceIdFromContent(a)!)! - rank.get(sourceIdFromContent(b)!)!);
  const otherRows = rows
    .filter((row) => !(row.dynamic_type === 'hot_list' && sourceIdFromContent(row)))
    .sort((a, b) => a.seq - b.seq);
  return [...hotRows, ...otherRows].map((row) => row.id);
}

function sourceIdFromContent(row: ContentDetailT): HotListSourceIdT | null {
  const parsed = HotListConfig.safeParse(row.dynamic_config);
  return parsed.success ? parsed.data.source : null;
}
