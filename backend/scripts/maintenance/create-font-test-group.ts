#!/usr/bin/env bun
import type { ContentDetailT, FontTestFontIdT } from 'shared';
import { FONT_TEST_FONTS } from 'shared';
import type { ContentsReadService } from '../../src/modules/contents/contents-read.service';
import type { ContentsService } from '../../src/modules/contents/contents.service';
import type { DynamicContentService } from '../../src/modules/dynamic-content/dynamic-content.service';
import {
  createGroupScriptServices,
  deleteAllContents,
  ensureGroup,
  readArgValue,
  resolveUser,
  userDisplay,
  type UserSelectorArgs,
} from '../helpers/bootstrap-app';

interface Args extends UserSelectorArgs {
  groupName: string;
  replace: boolean;
}

const args = parseArgs(process.argv.slice(2));
const services = await createGroupScriptServices();

try {
  const { prisma, groups, contents, contentReads, dynamicContent } = services;
  const user = await resolveUser(prisma, args);
  const group = await ensureGroup(groups, prisma, user.id, args.groupName);

  if (args.replace) {
    await deleteAllContents(contents, contentReads, group.id, user.id);
  } else {
    await deleteDuplicateFontTests(contents, contentReads, group.id, user.id);
  }

  const generated = await upsertFontFrames(
    contents,
    contentReads,
    dynamicContent,
    group.id,
    user.id
  );
  const finalRows = await contentReads.list(group.id, { userId: user.id });
  const orderedIds = orderedContentIds(finalRows);
  const { manifest_etag } = await contents.reorder(group.id, user.id, orderedIds);

  process.stdout.write(
    [
      `Font test group ready: ${args.groupName}`,
      `  user: ${userDisplay(user)}`,
      `  group_id: ${group.id}`,
      `  frames: ${generated.length}`,
      `  manifest_etag: ${manifest_etag}`,
    ].join('\n') + '\n'
  );
} finally {
  await services.app.close();
}
process.exit(0);

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

function printHelpAndExit(): never {
  process.stdout.write(`Usage:
  bun run scripts/maintenance/create-font-test-group.ts [--email <email> | --username <name> | --user-id <id>]

Options:
  --group-name <name>  Group name to create or update. Default: 字体测试
  --replace            Delete all existing contents in the target group before creating frames.
`);
  process.exit(0);
}

async function deleteDuplicateFontTests(
  contents: ContentsService,
  contentReads: ContentsReadService,
  groupId: string,
  userId: string
): Promise<void> {
  const rows = await contentReads.list(groupId, { userId });
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
  contentReads: ContentsReadService,
  dynamicContent: DynamicContentService,
  groupId: string,
  userId: string
): Promise<Array<{ fontId: FontTestFontIdT; contentId: string }>> {
  const rows = await contentReads.list(groupId, { userId });
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
      await dynamicContent.patch(existing.id, userId, {
        frame_name: font.label,
        config,
      });
      generated.push({ fontId: font.id, contentId: existing.id });
      continue;
    }

    const created = await dynamicContent.append(groupId, userId, {
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
