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
import { audioBlobContentId } from '../../audio/audio-blob-id';
import { GroupsService } from '../../groups/groups.service';
import { TtsAudioCacheService, TtsService } from '../../tts/tts.service';
import { datePartsInTz, timezoneFromConfig } from '../timezone';
import { claimLeaseJobs } from '../lease-claim';

type TtsVoiceValue = (typeof TTS_VOICES)[number];

const WORKER_INTERVAL_MS = 5_000;
const WORKER_BATCH_SIZE = 3;
const LEASE_MS = 120_000;
const MAX_AUDIO_ATTEMPTS = 3;

@Injectable()
export class DynamicAudioService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DynamicAudioService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly config: AppConfig,
    private readonly groups: GroupsService,
    private readonly tts: TtsService,
    private readonly ttsCache: TtsAudioCacheService
  ) {}

  onModuleInit(): void {
    if (!this.config.backgroundWorkers) return;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), WORKER_INTERVAL_MS);
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
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

    if (
      content.audioEtag &&
      content.audioStatus === 'ready' &&
      content.audioVoice === voice &&
      content.audioText === text &&
      (await this.ttsCache.readByEtag(content.audioEtag))
    ) {
      return false;
    }

    const previousAudioEtag = content.audioEtag;
    await this.prisma.content.update({
      where: { id: content.id },
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
    await this.deleteAudioBlob(content.groupId, content.id, previousAudioEtag);
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
    try {
      const cached = await this.ttsCache.getOrCreate({
        text: input.text,
        voice: input.voice,
      });
      const updated = await this.prisma.content.updateMany({
        where: {
          id: input.contentId,
          groupId: input.groupId,
          audioStatus: 'generating',
          audioSource: 'tts',
          audioVoice: input.voice,
          audioText: input.text,
          audioLeaseUntil: input.leaseUntil,
        },
        data: {
          audioEtag: cached.etag,
          audioSize: cached.size,
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
      if (updated.count !== 1) return;
    } catch (err) {
      this.logger.warn(`dynamic TTS failed content=${input.contentId}: ${formatError(err)}`);
      await this.markFailedOrRetry(input, err);
    } finally {
      await this.groups.recomputeManifestEtag(input.groupId);
    }
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
      current.audioLeaseUntil?.getTime() !== input.leaseUntil.getTime()
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
        audioLeaseUntil: input.leaseUntil,
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
    await this.deleteAudioBlob(content.groupId, content.id, previousAudioEtag);
    return true;
  }

  private async deleteAudioBlob(
    groupId: string,
    contentId: string,
    audioEtag: string | null
  ): Promise<void> {
    if (!audioEtag) return;
    await this.blob
      .delete(groupId, audioBlobContentId(contentId, audioEtag), 'audio')
      .catch(() => {});
  }
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
  const label =
    valueText(recordValue(data, 'dateLabel')) ?? cnMonthDay(now, timezoneFromConfig(config));
  const lines = ['line0', 'line1', 'line2', 'line3', 'line4']
    .map((key) => valueText(recordValue(data, key)))
    .filter((line): line is string => !!line);
  return compactSentence([`历史上的${label.replace(/\s+/g, '')}`, ...lines]);
}

function recordValue(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function valueText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function compactSentence(parts: string[]): string {
  return parts
    .map((part) => part.trim().replace(/[。；;,，]+$/g, ''))
    .filter(Boolean)
    .join('。')
    .slice(0, 500);
}

function cnMonthDay(date: Date, timeZone: string): string {
  const parts = datePartsInTz(date, timeZone);
  return `${parts.month}月${parts.day}日`;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
