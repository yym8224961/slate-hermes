import type { ContentAudioSource, ContentAudioStatus, ContentKind, Prisma } from '@prisma/client';
import {
  DynamicConfig,
  TTS_VOICES,
  TtsVoice,
  type ContentDetailT,
  type ContentSummaryT,
  type DynamicTypeT,
} from 'shared';
import {
  dashboardStatusBarText,
  deviceStatusBarText,
  fontTestStatusBarText,
  hotListStatusBarText,
  weatherAlertStatusBarText,
  weatherStatusBarText,
} from './content-status-bar';

type TtsVoiceValue = (typeof TTS_VOICES)[number];

export interface ContentRow {
  id: string;
  groupId?: string;
  sortOrder: number;
  frameName: string | null;
  contentEtag: string;
  imageEtag: string;
  audioEtag: string | null;
  imageSize: number;
  audioSize: number | null;
  audioStatus: ContentAudioStatus;
  audioSource: ContentAudioSource | null;
  audioVoice: string | null;
  audioText?: string | null;
  audioLastError?: string | null;
  audioUpdatedAt?: Date | null;
  kind: ContentKind;
  dynamicType: string | null;
  dynamicNextRunAt?: Date | null;
  dynamicRefreshDueAt?: Date | null;
  dynamicConfig?: Prisma.JsonValue | null;
  dynamicData?: Prisma.JsonValue | null;
  dynamicLastRunAt?: Date | null;
  dynamicLastError?: string | null;
}

export function contentToSummary(row: ContentRow): ContentSummaryT {
  return {
    id: row.id,
    seq: row.sortOrder,
    content_etag: row.contentEtag,
    frame_name: row.frameName,
    device_status_bar_text: deviceStatusBarText({ ...row, renderedAt: row.dynamicLastRunAt }),
    image_etag: row.imageEtag,
    audio_etag: row.audioEtag,
    image_size: row.imageSize,
    audio_size: row.audioSize,
    audio_status: row.audioStatus,
    audio_source: row.audioSource,
    audio_voice: TtsVoice.safeParse(row.audioVoice).success
      ? (row.audioVoice as TtsVoiceValue)
      : null,
    kind: row.kind === 'dynamic' ? 'dynamic' : 'image',
    dynamic_type: (row.dynamicType as DynamicTypeT | null) ?? null,
    next_wake_sec: nextWakeSec(row.dynamicNextRunAt ?? null),
  };
}

export function contentToDetail(
  row: ContentRow & {
    groupId: string;
    dynamicLastRunAt?: Date | null;
    dynamicLastError?: string | null;
  }
): ContentDetailT {
  const config = row.dynamicConfig ? DynamicConfig.safeParse(row.dynamicConfig) : null;
  return {
    ...contentToSummary(row),
    group_id: row.groupId,
    dynamic_config: config?.success ? config.data : null,
    dynamic_data: row.dynamicData ?? null,
    dynamic_last_rendered_at: row.dynamicLastRunAt?.toISOString() ?? null,
    dynamic_next_render_at: row.dynamicNextRunAt?.toISOString() ?? null,
    dynamic_render_error: row.dynamicLastError ?? null,
    audio_text: row.audioText ?? null,
    audio_error: row.audioLastError ?? null,
    audio_updated_at: row.audioUpdatedAt?.toISOString() ?? null,
  };
}

export function defaultDynamicFrameName(
  dynamicType: string | null,
  config?: unknown
): string | null {
  switch (dynamicType) {
    case 'daily_calendar':
      return '日历';
    case 'month_calendar':
      return '月历';
    case 'history_today':
      return '历史上的今天';
    case 'weather_alert':
      return weatherAlertStatusBarText(config);
    case 'earthquake_report':
      return '地震速报';
    case 'weather':
      return weatherStatusBarText(config);
    case 'dashboard':
      return dashboardStatusBarText(config);
    case 'font_test':
      return fontTestStatusBarText(config);
    case 'hot_list':
      return hotListStatusBarText(config);
    default:
      return null;
  }
}

function nextWakeSec(nextRunAt: Date | null): number | null {
  if (!nextRunAt) return null;
  return Math.max(Math.ceil((nextRunAt.getTime() - Date.now()) / 1000), 0);
}
