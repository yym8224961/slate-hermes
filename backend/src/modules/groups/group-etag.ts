import { createHash } from 'node:crypto';
import type { ContentKind, Prisma } from '@prisma/client';
import { deviceStatusBarText } from '../contents/content-status-bar';

export interface GroupEtagContentRow {
  id: string;
  sortOrder: number;
  kind: ContentKind;
  dynamicType: string | null;
  imageEtag: string;
  imageSize: number;
  audioEtag: string | null;
  audioSize: number | null;
  audioStatus: string;
  audioSource: string | null;
  audioVoice: string | null;
  frameName: string | null;
  dynamicConfig?: Prisma.JsonValue | null;
  dynamicData?: Prisma.JsonValue | null;
  dynamicLastRunAt: Date | null;
  contentEtag: string;
}

export interface GroupEtagInput {
  name: string;
  sortOrder: number;
  contents: GroupEtagContentRow[];
}

export interface ComputedGroupEtags {
  structureEtag: string;
  manifestEtag: string;
  contentEtags: Array<{ id: string; etag: string; previousEtag: string }>;
}

export function computeGroupEtags(group: GroupEtagInput): ComputedGroupEtags {
  const contentRows = group.contents.map((content) => ({
    id: content.id,
    sortOrder: content.sortOrder,
    kind: content.kind,
    dynamicType: content.dynamicType ?? '',
    imageEtag: content.imageEtag,
    imageSize: content.imageSize,
    audioEtag: content.audioEtag ?? '',
    audioSize: content.audioSize ?? '',
    audioStatus: content.audioStatus,
    audioSource: content.audioSource ?? '',
    audioVoice: content.audioVoice ?? '',
    frameName: content.frameName ?? '',
    dynamicConfig: stableJson(content.dynamicConfig ?? null),
    dynamicData: stableJson(content.dynamicData ?? null),
    statusBarText: deviceStatusBarText({ ...content, renderedAt: content.dynamicLastRunAt }),
    previousEtag: content.contentEtag,
  }));
  const contentEtags = contentRows.map((content) => ({
    id: content.id,
    previousEtag: content.previousEtag,
    etag: hashParts([
      'content',
      content.id,
      content.sortOrder,
      content.kind,
      content.dynamicType,
      content.imageEtag,
      content.imageSize,
      content.audioEtag,
      content.audioSize,
      content.audioStatus,
      content.audioSource,
      content.audioVoice,
      content.frameName,
      content.dynamicConfig,
      content.dynamicData,
      content.statusBarText,
    ]),
  }));
  const structureEtag = hashParts([
    'structure',
    ...contentRows.map((content) =>
      [content.id, content.sortOrder, content.kind, content.dynamicType].join(':')
    ),
  ]);
  const manifestEtag = hashParts([
    'manifest',
    group.name,
    group.sortOrder,
    structureEtag,
    ...contentEtags.map((content) => `${content.id}:${content.etag}`),
  ]);

  return { structureEtag, manifestEtag, contentEtags };
}

function hashParts(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

function stableJson(value: Prisma.JsonValue | null): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: Prisma.JsonValue | null): Prisma.JsonValue | null {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item as Prisma.JsonValue)])
    ) as Prisma.JsonObject;
  }
  return value;
}
