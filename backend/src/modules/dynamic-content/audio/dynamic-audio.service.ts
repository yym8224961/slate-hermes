import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DynamicConfig, TTS_VOICES, isAudioDynamicConfig, isTtsVoice } from 'shared';
import { BlobService } from '../../../infra/blob/blob.service';
import { AppConfig } from '../../../infra/config/app.config';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { computeETag } from '../../../common/utils/etag';
import { formatError } from '../../../common/utils/error-format';
import { WorkerLoop } from '../../../common/worker/worker-loop';
import {
  audioBlobContentId,
  deleteContentAudioBlob,
  readContentAudioBlob,
} from '../../../infra/blob/content-audio-blobs';
import { GroupsService } from '../../groups/groups.service';
import { TtsService } from '../../tts/tts.service';
import { buildDynamicAudioTextForContent } from './dynamic-audio-text';
import { claimLeaseJobs } from '../../../common/worker/lease-claim';

type TtsVoiceValue = (typeof TTS_VOICES)[number];

const WORKER_INTERVAL_MS = 5_000;
const WORKER_BATCH_SIZE = 3;
const LEASE_MS = 120_000;
const MAX_AUDIO_ATTEMPTS = 3;
const LEASE_MATCH_TOLERANCE_MS = 1000;

@Injectable()
export class DynamicAudioService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DynamicAudioService.name);
  private readonly loop: WorkerLoop;

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly config: AppConfig,
    private readonly groups: GroupsService,
    private readonly tts: TtsService
  ) {
    this.loop = new WorkerLoop({
      run: async () => {
        await this.runBatch();
        return WORKER_INTERVAL_MS;
      },
      onError: (err) => {
        this.logger.warn(`Dynamic TTS worker tick failed: ${formatError(err)}`);
      },
      fallbackDelayMs: WORKER_INTERVAL_MS,
    });
  }

  onModuleInit(): void {
    if (!this.config.backgroundWorkers) return;
    this.loop.start(0);
  }

  onModuleDestroy(): void {
    this.loop.stop();
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
    const text = buildDynamicAudioTextForContent(
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
    await this.loop.tick();
  }

  private async runBatch(): Promise<void> {
    const jobs = await this.claimPendingJobs(WORKER_BATCH_SIZE);
    for (const job of jobs) {
      await this.run(job).catch((err: unknown) => {
        this.logger.warn(
          `Dynamic TTS worker job failed for content ${job.contentId} with voice ${job.voice}: ${formatError(err)}`
        );
      });
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
      if (updated.count === 1) {
        this.logger.log(
          `Dynamic TTS audio was generated for content ${input.contentId} with voice ${input.voice}.`
        );
        return;
      }
      // CAS 失败：lease 已被其它 worker 抢走（120s 超时后）。如果 TTS 对相同 text/voice 是确定性
      // 的，对方写到同一路径同一字节；这种情况绝不能删，否则会把已经 ready 的 blob 抽走。
      await this.cleanupOrphanBlob(input.groupId, input.contentId, generatedEtag);
    } catch (err) {
      await this.cleanupOrphanBlob(input.groupId, input.contentId, pendingCleanupEtag);
      this.logger.warn(
        `Dynamic TTS generation failed for content ${input.contentId} with voice ${input.voice}: ${formatError(err)}`
      );
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
