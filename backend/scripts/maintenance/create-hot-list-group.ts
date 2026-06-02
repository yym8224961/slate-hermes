#!/usr/bin/env bun
import {
  HOT_LIST_SOURCES_BY_NAME,
  HotListConfig,
  MAINSTREAM_HOT_LIST_SOURCES,
  hotListSourceDisplayLabel,
  type ContentDetailT,
  type HotListSourceCatalogEntry,
  type HotListSourceIdT,
} from 'shared';
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
  refreshIntervalSec: number;
  allSources: boolean;
}

const args = parseArgs(process.argv.slice(2));
const selectedSources = args.allSources ? HOT_LIST_SOURCES_BY_NAME : MAINSTREAM_HOT_LIST_SOURCES;
const selectedSourceSet = new Set<HotListSourceIdT>(selectedSources.map((source) => source.id));
const hotListConfigs = buildHotListConfigs(args.refreshIntervalSec, selectedSources);
const services = await createGroupScriptServices();

try {
  const { prisma, groups, contents, contentReads, dynamicContent } = services;
  const user = await resolveUser(prisma, args);
  const group = await ensureGroup(groups, prisma, user.id, args.groupName);

  if (args.replace) {
    await deleteAllContents(contents, contentReads, group.id, user.id);
  } else {
    await deleteDuplicateHotLists(contents, contentReads, group.id, user.id, selectedSourceSet);
  }

  const generated = await upsertHotListFrames(
    contents,
    contentReads,
    dynamicContent,
    group.id,
    user.id,
    hotListConfigs
  );
  const finalRows = await contentReads.list(group.id, { userId: user.id });
  const orderedIds = orderedContentIds(finalRows);
  const { manifest_etag } = await contents.reorder(group.id, user.id, orderedIds);

  process.stdout.write(
    [
      `Hot list group ready: ${args.groupName}`,
      `  user: ${userDisplay(user)}`,
      `  group_id: ${group.id}`,
      `  sources: ${args.allSources ? 'all' : 'mainstream'}`,
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
    groupName: '热榜',
    replace: false,
    refreshIntervalSec: 600,
    allSources: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--replace') {
      args.replace = true;
    } else if (arg === '--all-sources') {
      args.allSources = true;
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

function readPositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} requires a positive integer`);
  return n;
}

function printHelpAndExit(): never {
  process.stdout.write(`Usage:
  bun run scripts/maintenance/create-hot-list-group.ts [--email <email> | --username <name> | --user-id <id>]

Options:
  --group-name <name>             Group name to create or update. Default: 热榜
  --all-sources                   Create every hot-list source. Default: mainstream sources only.
  --replace                       Delete all existing contents in the target group before creating frames.
  --refresh-interval-sec <sec>    Hot-list refresh interval. Default: 600
`);
  process.exit(0);
}

async function deleteDuplicateHotLists(
  contents: ContentsService,
  contentReads: ContentsReadService,
  groupId: string,
  userId: string,
  selectedSourceSet: ReadonlySet<HotListSourceIdT>
): Promise<void> {
  const rows = await contentReads.list(groupId, { userId });
  const seen = new Set<HotListSourceIdT>();

  for (const row of rows) {
    if (row.dynamic_type !== 'hot_list') continue;
    const sourceId = sourceIdFromContent(row);
    if (!sourceId || !selectedSourceSet.has(sourceId) || seen.has(sourceId)) {
      await contents.delete(row.id, userId);
      continue;
    }
    seen.add(sourceId);
  }
}

async function upsertHotListFrames(
  contents: ContentsService,
  contentReads: ContentsReadService,
  dynamicContent: DynamicContentService,
  groupId: string,
  userId: string,
  configs: Map<HotListSourceIdT, ReturnType<typeof HotListConfig.parse>>
): Promise<Array<{ sourceId: HotListSourceIdT; contentId: string }>> {
  const rows = await contentReads.list(groupId, { userId });
  const bySource = new Map<HotListSourceIdT, ContentDetailT>();
  for (const row of rows) {
    if (row.dynamic_type !== 'hot_list') continue;
    const sourceId = sourceIdFromContent(row);
    if (sourceId) bySource.set(sourceId, row);
  }

  const generated: Array<{ sourceId: HotListSourceIdT; contentId: string }> = [];
  for (const source of selectedSources) {
    const config = configs.get(source.id);
    if (!config) throw new Error(`Missing hot-list config for source: ${source.id}`);
    const frameName = hotListSourceDisplayLabel(source);
    const existing = bySource.get(source.id);
    if (existing) {
      await dynamicContent.patch(existing.id, userId, {
        frame_name: frameName,
        config,
      });
      generated.push({ sourceId: source.id, contentId: existing.id });
      continue;
    }

    const created = await dynamicContent.append(groupId, userId, {
      kind: 'dynamic',
      frame_name: frameName,
      config,
    });
    generated.push({ sourceId: source.id, contentId: created.id });
  }
  return generated;
}

function buildHotListConfigs(
  refreshIntervalSec: number,
  sources: readonly HotListSourceCatalogEntry[]
): Map<HotListSourceIdT, ReturnType<typeof HotListConfig.parse>> {
  return new Map(
    sources.map((source) => [
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
    selectedSources.map((source, index) => [source.id, index])
  );
  const hotRows = rows
    .filter((row) => {
      if (row.dynamic_type !== 'hot_list') return false;
      const sourceId = sourceIdFromContent(row);
      return !!sourceId && rank.has(sourceId);
    })
    .sort((a, b) => rank.get(sourceIdFromContent(a)!)! - rank.get(sourceIdFromContent(b)!)!);
  const otherRows = rows
    .filter((row) => {
      if (row.dynamic_type !== 'hot_list') return true;
      const sourceId = sourceIdFromContent(row);
      return !sourceId || !rank.has(sourceId);
    })
    .sort((a, b) => a.seq - b.seq);
  return [...hotRows, ...otherRows].map((row) => row.id);
}

function sourceIdFromContent(row: ContentDetailT): HotListSourceIdT | null {
  const parsed = HotListConfig.safeParse(row.dynamic_config);
  return parsed.success ? parsed.data.source : null;
}
