#!/usr/bin/env bun
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { ContentDetailT, FontTestFontIdT } from 'shared';
import { FONT_TEST_FONTS } from 'shared';
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
}

const args = parseArgs(process.argv.slice(2));
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
    await deleteDuplicateFontTests(contents, group.id, user.id);
  }

  const generated = await upsertFontFrames(contents, group.id, user.id);
  const finalRows = await contents.list(group.id, { userId: user.id });
  const orderedIds = orderedContentIds(finalRows);
  const { group_etag } = await contents.reorder(group.id, user.id, orderedIds);

  process.stdout.write(
    [
      `Font test group ready: ${args.groupName}`,
      `  user: ${user.email}${user.username ? ` (${user.username})` : ''}`,
      `  group_id: ${group.id}`,
      `  frames: ${generated.length}`,
      `  group_etag: ${group_etag}`,
    ].join('\n') + '\n'
  );
} finally {
  await app.close();
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    groupName: '字体测试',
    replace: false,
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

function printHelpAndExit(): never {
  process.stdout.write(`Usage:
  bun run scripts/create-font-test-group.ts [--email <email> | --username <name> | --user-id <id>]

Options:
  --group-name <name>  Group name to create or update. Default: 字体测试
  --replace            Delete all existing contents in the target group before creating frames.
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

async function deleteDuplicateFontTests(
  contents: ContentsService,
  groupId: string,
  userId: string
): Promise<void> {
  const rows = await contents.list(groupId, { userId });
  const seen = new Set<FontTestFontIdT>();
  const valid = new Set<FontTestFontIdT>(FONT_TEST_FONTS.map((font) => font.id));

  for (const row of rows) {
    if (row.dynamic_type !== 'font_test') continue;
    const fontId = fontIdFromContent(row);
    if (!fontId || !valid.has(fontId) || seen.has(fontId)) {
      await contents.delete(row.id, userId);
      continue;
    }
    seen.add(fontId);
  }
}

async function upsertFontFrames(
  contents: ContentsService,
  groupId: string,
  userId: string
): Promise<Array<{ fontId: FontTestFontIdT; contentId: string }>> {
  const rows = await contents.list(groupId, { userId });
  const byFont = new Map<FontTestFontIdT, ContentDetailT>();
  for (const row of rows) {
    if (row.dynamic_type !== 'font_test') continue;
    const fontId = fontIdFromContent(row);
    if (fontId) byFont.set(fontId, row);
  }

  const generated: Array<{ fontId: FontTestFontIdT; contentId: string }> = [];
  for (const font of FONT_TEST_FONTS) {
    const config = {
      type: 'font_test',
      font_id: font.id,
      invert: false,
    } as const;
    const existing = byFont.get(font.id);
    if (existing) {
      await contents.patchDynamic(existing.id, userId, {
        frame_name: font.label,
        config,
      });
      generated.push({ fontId: font.id, contentId: existing.id });
      continue;
    }

    const created = await contents.appendDynamic(groupId, userId, {
      kind: 'dynamic',
      frame_name: font.label,
      config,
    });
    generated.push({ fontId: font.id, contentId: created.id });
  }
  return generated;
}

function orderedContentIds(rows: ContentDetailT[]): string[] {
  const rank = new Map<FontTestFontIdT, number>(
    FONT_TEST_FONTS.map((font, index) => [font.id, index])
  );
  const fontRows = rows
    .filter((row) => row.dynamic_type === 'font_test' && fontIdFromContent(row))
    .sort((a, b) => rank.get(fontIdFromContent(a)!)! - rank.get(fontIdFromContent(b)!)!);
  const otherRows = rows
    .filter((row) => !(row.dynamic_type === 'font_test' && fontIdFromContent(row)))
    .sort((a, b) => a.seq - b.seq);
  return [...fontRows, ...otherRows].map((row) => row.id);
}

function fontIdFromContent(row: ContentDetailT): FontTestFontIdT | null {
  const config = row.dynamic_config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const id = (config as Record<string, unknown>).font_id;
  return typeof id === 'string' && isFontId(id) ? id : null;
}

function isFontId(value: string): value is FontTestFontIdT {
  return FONT_TEST_FONTS.some((font) => font.id === value);
}
