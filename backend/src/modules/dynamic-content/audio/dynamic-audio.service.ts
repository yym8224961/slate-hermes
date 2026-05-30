import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  DynamicConfig,
  TTS_VOICES,
  isAudioDynamicConfig,
  isTtsVoice,
  type DynamicConfigT,
} from 'shared';
import { BlobService } from '../../../infra/blob/blob.service';
import { AppConfig } from '../../../infra/config/app.config';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { computeETag } from '../../../common/etag/etag.util';
import { formatError } from '../../../common/error-format';
import { recordValue, valueText } from '../../../common/value-utils';
import { audioBlobContentId } from '../../audio/audio-blob-id';
import { deleteContentAudioBlob, readContentAudioBlob } from '../../audio/content-audio-blobs';
import { GroupsService } from '../../groups/groups.service';
import { TtsService } from '../../tts/tts.service';
import {
  normalizeHistoryYear,
  parseHistoryTodayData,
  type HistoryTodayProviderData,
} from '../history-today.data';
import { cnMonthDay, datePartsInTz, timezoneFromConfig } from '../timezone';
import { claimLeaseJobs } from '../lease-claim';
import { shortRegionName } from '../weather-region';

type TtsVoiceValue = (typeof TTS_VOICES)[number];

const WORKER_INTERVAL_MS = 5_000;
const WORKER_BATCH_SIZE = 3;
const LEASE_MS = 120_000;
const MAX_AUDIO_ATTEMPTS = 3;
const LEASE_MATCH_TOLERANCE_MS = 1000;

@Injectable()
export class DynamicAudioService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DynamicAudioService.name);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly config: AppConfig,
    private readonly groups: GroupsService,
    private readonly tts: TtsService
  ) {}

  onModuleInit(): void {
    if (!this.config.backgroundWorkers) return;
    if (this.timer) return;
    this.stopped = false;
    this.scheduleTick(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async sync(contentId: string, opts: { now?: Date } = {}): Promise<boolean> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        groupId: true,
        kind: true,
        dynamicType: true,
        dynamicConfig: true,
        dynamicData: true,
        dynamicLastRunAt: true,
        audioEtag: true,
        audioStatus: true,
        audioVoice: true,
        audioText: true,
      },
    });
    if (!content || content.kind !== 'dynamic' || !content.dynamicType) return false;

    const config = DynamicConfig.safeParse(content.dynamicConfig);
    if (!config.success || !isAudioDynamicConfig(config.data) || !config.data.audio_enabled) {
      return this.clearAudioIfPresent(content);
    }

    const voice = this.tts.normalizeVoice(config.data.audio_voice);
    const text = buildDynamicAudioText(
      content.dynamicType,
      config.data,
      content.dynamicData,
      opts.now ?? content.dynamicLastRunAt ?? new Date()
    );
    if (!text) {
      return this.clearAudioIfPresent(content);
    }

    const previousAudioEtag = content.audioEtag;
    if (
      previousAudioEtag &&
      content.audioStatus === 'ready' &&
      content.audioVoice === voice &&
      content.audioText === text &&
      (await readContentAudioBlob(this.blob, content.groupId, content.id, previousAudioEtag))
    ) {
      return false;
    }

    const updated = await this.prisma.content.updateMany({
      where: {
        id: content.id,
        dynamicLastRunAt: content.dynamicLastRunAt,
        audioEtag: previousAudioEtag,
        audioStatus: content.audioStatus,
        audioVoice: content.audioVoice,
        audioText: content.audioText,
      },
      data: {
        audioEtag: null,
        audioSize: null,
        audioStatus: 'pending',
        audioSource: 'tts',
        audioVoice: voice,
        audioText: text,
        audioLastError: null,
        audioUpdatedAt: new Date(),
        audioLeaseUntil: null,
        audioAttempts: 0,
      },
    });
    if (updated.count !== 1) return false;
    await deleteContentAudioBlob(this.blob, content.groupId, content.id, previousAudioEtag);
    return true;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.claimPendingJobs(WORKER_BATCH_SIZE);
      for (const job of jobs) {
        await this.run(job).catch((err: unknown) => {
          this.logger.warn(`TTS worker job failed content=${job.contentId}: ${formatError(err)}`);
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async claimPendingJobs(limit: number): Promise<
    Array<{
      contentId: string;
      groupId: string;
      text: string;
      voice: TtsVoiceValue;
      leaseUntil: Date;
    }>
  > {
    const now = new Date();
    const rows = await this.prisma.content.findMany({
      where: {
        audioSource: 'tts',
        audioText: { not: null },
        audioVoice: { not: null },
        audioAttempts: { lt: MAX_AUDIO_ATTEMPTS },
        OR: [
          { audioStatus: 'pending', audioLeaseUntil: null },
          { audioStatus: 'pending', audioLeaseUntil: { lte: now } },
          { audioStatus: 'generating', audioLeaseUntil: { lte: now } },
        ],
      },
      orderBy: [{ audioUpdatedAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: { id: true, groupId: true, audioText: true, audioVoice: true },
    });
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    return claimLeaseJobs(
      rows,
      (row) => {
        if (!row.audioText || !row.audioVoice || !isTtsVoice(row.audioVoice)) return null;
        return {
          contentId: row.id,
          groupId: row.groupId,
          text: row.audioText,
          voice: row.audioVoice,
          leaseUntil,
        };
      },
      async (row) => {
        const claimed = await this.prisma.content.updateMany({
          where: {
            id: row.id,
            audioSource: 'tts',
            audioText: row.audioText,
            audioVoice: row.audioVoice,
            audioAttempts: { lt: MAX_AUDIO_ATTEMPTS },
            OR: [
              { audioStatus: 'pending', audioLeaseUntil: null },
              { audioStatus: 'pending', audioLeaseUntil: { lte: now } },
              { audioStatus: 'generating', audioLeaseUntil: { lte: now } },
            ],
          },
          data: {
            audioStatus: 'generating',
            audioLastError: null,
            audioLeaseUntil: leaseUntil,
            audioAttempts: { increment: 1 },
            audioUpdatedAt: now,
          },
        });
        return claimed.count === 1;
      }
    );
  }

  private async run(input: {
    contentId: string;
    groupId: string;
    text: string;
    voice: TtsVoiceValue;
    leaseUntil: Date;
  }): Promise<void> {
    let pendingCleanupEtag: string | null = null;
    try {
      const bytes = await this.tts.synthesizeToDevicePcm({
        text: input.text,
        voice: input.voice,
      });
      const generatedEtag = computeETag(bytes);
      pendingCleanupEtag = generatedEtag;
      await this.blob.write(
        input.groupId,
        audioBlobContentId(input.contentId, generatedEtag),
        'audio',
        bytes
      );
      const updated = await this.prisma.content.updateMany({
        where: {
          id: input.contentId,
          groupId: input.groupId,
          audioStatus: 'generating',
          audioSource: 'tts',
          audioVoice: input.voice,
          audioText: input.text,
          audioLeaseUntil: leaseWindow(input.leaseUntil),
        },
        data: {
          audioEtag: generatedEtag,
          audioSize: bytes.byteLength,
          audioStatus: 'ready',
          audioSource: 'tts',
          audioVoice: input.voice,
          audioText: input.text,
          audioLastError: null,
          audioUpdatedAt: new Date(),
          audioLeaseUntil: null,
          audioAttempts: 0,
        },
      });
      if (updated.count === 1) return;
      // CAS 失败：lease 已被其它 worker 抢走（120s 超时后）。如果 TTS 对相同 text/voice 是确定性
      // 的，对方写到同一路径同一字节；这种情况绝不能删，否则会把已经 ready 的 blob 抽走。
      await this.cleanupOrphanBlob(input.groupId, input.contentId, generatedEtag);
    } catch (err) {
      await this.cleanupOrphanBlob(input.groupId, input.contentId, pendingCleanupEtag);
      this.logger.warn(`dynamic TTS failed content=${input.contentId}: ${formatError(err)}`);
      await this.markFailedOrRetry(input, err);
    } finally {
      await this.groups.recomputeManifestEtag(input.groupId);
    }
  }

  // 仅当目标 etag 不再被任何 content 行引用时才删。规避 race：worker A 的 lease 过期、worker B
  // 抢占后用相同的 text/voice 重合成出相同 etag，会写到同一 blob 路径；A 的 CAS 失败后若无脑删
  // 路径，B 刚成功提交的 ready 行立刻指向不存在的文件。
  private async cleanupOrphanBlob(
    groupId: string,
    contentId: string,
    etag: string | null
  ): Promise<void> {
    if (!etag) return;
    const row = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { audioEtag: true },
    });
    if (row?.audioEtag === etag) return;
    await deleteContentAudioBlob(this.blob, groupId, contentId, etag);
  }

  private async markFailedOrRetry(
    input: {
      contentId: string;
      text: string;
      voice: TtsVoiceValue;
      leaseUntil: Date;
    },
    err: unknown
  ): Promise<void> {
    const current = await this.prisma.content.findUnique({
      where: { id: input.contentId },
      select: {
        audioStatus: true,
        audioSource: true,
        audioVoice: true,
        audioText: true,
        audioLeaseUntil: true,
        audioAttempts: true,
      },
    });
    if (
      !current ||
      current.audioStatus !== 'generating' ||
      current.audioSource !== 'tts' ||
      current.audioVoice !== input.voice ||
      current.audioText !== input.text ||
      !sameLeaseTime(current.audioLeaseUntil, input.leaseUntil)
    ) {
      return;
    }
    const exhausted = current.audioAttempts >= MAX_AUDIO_ATTEMPTS;
    const retryDelayMs = Math.min(60_000, 5_000 * 2 ** Math.max(current.audioAttempts - 1, 0));
    const now = new Date();
    await this.prisma.content.updateMany({
      where: {
        id: input.contentId,
        audioStatus: 'generating',
        audioSource: 'tts',
        audioVoice: input.voice,
        audioText: input.text,
        audioLeaseUntil: leaseWindow(input.leaseUntil),
      },
      data: {
        audioStatus: exhausted ? 'failed' : 'pending',
        audioLastError: formatError(err).slice(0, 512),
        audioUpdatedAt: now,
        audioLeaseUntil: exhausted ? null : new Date(now.getTime() + retryDelayMs),
      },
    });
  }

  private async clearAudioIfPresent(content: {
    id: string;
    groupId: string;
    audioEtag: string | null;
    audioStatus: string;
  }): Promise<boolean> {
    if (!content.audioEtag && content.audioStatus === 'none') return false;
    const previousAudioEtag = content.audioEtag;
    await this.prisma.content.update({
      where: { id: content.id },
      data: {
        audioEtag: null,
        audioSize: null,
        audioStatus: 'none',
        audioSource: null,
        audioVoice: null,
        audioText: null,
        audioLastError: null,
        audioUpdatedAt: new Date(),
        audioLeaseUntil: null,
        audioAttempts: 0,
      },
    });
    await deleteContentAudioBlob(this.blob, content.groupId, content.id, previousAudioEtag);
    return true;
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((err: unknown) => {
          this.logger.warn(`TTS worker tick failed: ${formatError(err)}`);
        })
        .finally(() => this.scheduleTick(WORKER_INTERVAL_MS));
    }, delayMs);
    this.timer.unref?.();
  }
}

function sameLeaseTime(actual: Date | null | undefined, expected: Date): boolean {
  return (
    actual !== null &&
    actual !== undefined &&
    Math.abs(actual.getTime() - expected.getTime()) <= LEASE_MATCH_TOLERANCE_MS
  );
}

function leaseWindow(date: Date): { gte: Date; lte: Date } {
  return {
    gte: new Date(date.getTime() - LEASE_MATCH_TOLERANCE_MS),
    lte: new Date(date.getTime() + LEASE_MATCH_TOLERANCE_MS),
  };
}

export function buildDynamicAudioTextForContent(
  dynamicType: string,
  config: DynamicConfigT,
  data: unknown,
  now: Date = new Date()
): string {
  return buildDynamicAudioText(dynamicType, config, data, now);
}

function buildDynamicAudioText(
  dynamicType: string,
  config: DynamicConfigT,
  data: unknown,
  now: Date
): string {
  switch (dynamicType) {
    case 'daily_calendar':
      return buildDailyCalendarAudio(data, config, now);
    case 'month_calendar':
      return buildMonthCalendarAudio(data, config, now);
    case 'weather':
      return buildWeatherAudio(data, config);
    case 'history_today':
      return buildHistoryTodayAudio(data, config, now);
    case 'weather_alert':
      return buildWeatherAlertAudio(data, config);
    case 'earthquake_report':
      return buildEarthquakeReportAudio(data);
    default:
      return '';
  }
}

function buildDailyCalendarAudio(data: unknown, config: DynamicConfigT, now: Date): string {
  const parts = datePartsInTz(now, timezoneFromConfig(config));
  const month = valueText(recordValue(data, 'month')) ?? String(parts.month);
  const day = valueText(recordValue(data, 'day')) ?? String(parts.day);
  const weekday = valueText(recordValue(data, 'weekdayCN')) ?? '';
  const lunar = valueText(recordValue(data, 'lunarDate')) ?? valueText(recordValue(data, 'lunar'));
  const term = valueText(recordValue(data, 'solarTerm'));
  const festival = valueText(recordValue(data, 'festival'));
  return compactSentence([
    `今天是${month}月${day}日${weekday ? `，${weekday}` : ''}`,
    lunar ? `${lunar}` : '',
    term ? `今日节气${term}` : '',
    festival ? `今天是${festival}` : '',
  ]);
}

function buildMonthCalendarAudio(data: unknown, config: DynamicConfigT, now: Date): string {
  const parts = datePartsInTz(now, timezoneFromConfig(config));
  const monthKey = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
  const dayKey = `${monthKey}-${String(parts.day).padStart(2, '0')}`;
  const days = recordValue(
    recordValue(recordValue(recordValue(data, 'calendar'), 'months'), monthKey),
    'days'
  );
  const today = recordValue(days, dayKey);
  const lunar = valueText(recordValue(today, 'lunar_date'));
  const term = valueText(recordValue(today, 'solar_term'));
  const festival = valueText(recordValue(today, 'festival'));
  return compactSentence([
    `现在是${parts.year}年${parts.month}月`,
    `今天${parts.month}月${parts.day}日`,
    lunar ? `${lunar}` : '',
    term ? `今日节气${term}` : '',
    festival ? `今天是${festival}` : '',
  ]);
}

function buildWeatherAudio(data: unknown, config: DynamicConfigT): string {
  const location = valueText(recordValue(config, 'location_label')) ?? '本地';
  const summary = valueText(recordValue(data, 'summary')) ?? '天气数据暂不可用';
  const temp = valueText(recordValue(data, 'tempC'));
  const feels = valueText(recordValue(data, 'feelsLikeC'));
  const humidity = valueText(recordValue(data, 'humidity'));
  const wind = valueText(recordValue(data, 'windDisplay'));
  return compactSentence([
    `${location}今天天气，${summary}`,
    temp ? `${temp}度` : '',
    feels ? `体感${feels}度` : '',
    humidity ? `湿度${humidity}%` : '',
    wind ? `${wind}` : '',
  ]);
}

function buildHistoryTodayAudio(data: unknown, config: DynamicConfigT, now: Date): string {
  const parsed = parseHistoryTodayData(data);
  if (!parsed) return '';
  const label = parsed.dateLabel || cnMonthDay(now, timezoneFromConfig(config));
  const items = historyAudioItems(parsed);
  return compactSentence([`历史上的${label.replace(/\s+/g, '')}`, ...items]);
}

function buildWeatherAlertAudio(data: unknown, config: DynamicConfigT): string {
  const items = recordArray(recordValue(data, 'items'));
  const province =
    valueText(recordValue(data, 'province')) || valueText(recordValue(config, 'province')) || '';
  const region = province ? shortRegionName(province) : '全国';
  if (items.length === 0) return `${region}暂无气象预警`;

  const warnings = items.slice(0, 3).flatMap((item): string[] => {
    const title = valueText(recordValue(item, 'title'));
    if (!title) return [];
    return [weatherAlertAudioLine(title)];
  });
  if (warnings.length === 0) return `${region}暂无气象预警`;
  return compactSentence([`${region}气象预警，播报最新${cnCount(warnings.length)}条`, ...warnings]);
}

function buildEarthquakeReportAudio(data: unknown): string {
  const items = recordArray(recordValue(data, 'items'));
  if (items.length === 0) return '暂无地震速报';

  const latest = earthquakeLatestAudio(items[0]);
  const rest = items.slice(1, 4).map(earthquakeBriefAudio).filter(Boolean);
  const restText = rest.length > 0 ? `其余${cnCount(rest.length)}条：${rest.join('；')}` : '';
  return compactSentence(['中国地震台网最新速报', latest, restText]);
}

function historyAudioItems(data: HistoryTodayProviderData): string[] {
  return data.items.map((item) => `${formatSpokenYear(item.year)}，${item.display}`);
}

function formatSpokenYear(year: string): string {
  const text = normalizeHistoryYear(year) ?? year.trim();
  if (text.startsWith('前')) return `公元前${text.slice(1)}年`;
  return `公元${text}年`;
}

function compactSentence(parts: string[]): string {
  return parts
    .map((part) => part.trim().replace(/[。；;,，]+$/g, ''))
    .filter(Boolean)
    .join('。')
    .slice(0, 500);
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => {
        return !!item && typeof item === 'object' && !Array.isArray(item);
      })
    : [];
}

function weatherAlertAudioLine(title: string): string {
  const normalized = title.replace(/\s+/g, '');
  const match = normalized.match(/^(.*?)发布(.+?)预警(?:信号)?$/);
  if (!match) return normalized.replace(/预警信号/g, '预警');

  const source = shortRegionName(match[1] ?? '');
  const signal = (match[2] ?? '').replace(/预警(?:信号)?$/g, '');
  return source ? `${source}发布${signal}预警` : `${signal}预警`;
}

function earthquakeLatestAudio(item: Record<string, unknown>): string {
  const location = valueText(recordValue(item, 'location')) ?? '';
  const magnitude = valueText(recordValue(item, 'magnitude')) ?? '';
  const depth = valueText(recordValue(item, 'depthKm')) ?? '';
  const occurredAt = valueText(recordValue(item, 'occurredAt')) ?? '';
  return compactSentence([
    `最新一条，${location || '未知位置'}`,
    magnitude ? `震级${magnitude}级` : '',
    depth && depth !== '-' && depth !== '--' ? `震源深度${depth}千米` : '',
    occurredAt ? `发生时间${shortSpokenTime(occurredAt)}` : '',
  ]);
}

function earthquakeBriefAudio(item: Record<string, unknown>): string {
  const location = valueText(recordValue(item, 'location')) ?? '';
  const magnitude = valueText(recordValue(item, 'magnitude')) ?? '';
  return [location || '未知位置', magnitude ? `震级${magnitude}级` : ''].filter(Boolean).join('，');
}

function cnCount(value: number): string {
  return ['零', '一', '二', '三', '四'][value] ?? String(value);
}

function shortSpokenTime(value: string): string {
  const text = value.trim();
  const match = text.match(/(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})日?\s+(\d{1,2}):(\d{2})/);
  if (!match) return text;
  return `${Number(match[2])}月${Number(match[3])}日${Number(match[4])}点${match[5]}分`;
}
