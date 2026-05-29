import { createId } from '@paralleldrive/cuid2';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ContentAudioSource, ContentKind } from '@prisma/client';
import {
  DashboardDataPayload,
  DynamicConfig,
  isAudioDynamicConfig,
  type ContentDetailT,
  type IngestPayloadT,
  type ContentMutationResponseT,
  type ContentSummaryT,
  type CreateDynamicContentRequestT,
  type ManifestResponseT,
} from 'shared';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { computeETag } from '../../common/etag/etag.util';
import { ConflictError, InternalError, NotFoundError, ValidationError } from '../../common/errors';
import { lockGroupRow } from '../../common/db/row-locks';
import { bulkSetContentSortOrder } from '../../common/db/bulk-sort-order';
import type { PrismaClientLike } from '../../common/db/prisma-client-like';
import { formatError } from '../../common/utils';
import { AudioService } from '../audio/audio.service';
import { audioBlobContentId } from '../audio/audio-blob-id';
import { TtsService } from '../tts/tts.service';
import { GroupsService } from '../groups/groups.service';
import { ImageRendererService } from '../image-renderer/image-renderer.service';
import { DynamicContentRegistry } from '../dynamic-content/dynamic-content-registry';
import { DynamicContentRendererService } from '../dynamic-content/dynamic-content-renderer.service';
import { ContentAudioBlobService } from './content-audio-blob.service';
import { contentToDetail, contentToSummary, defaultDynamicFrameName } from './content-presenter';
import type { ParsedContentUpload } from './multipart.parser';
import type { DevicePollSnapshot } from '../devices/devices.service';
import { BlobRollbackPlan } from './blob-rollback';

interface CurrentContentRequest {
  deviceId: string;
  groupId: string;
  seq: number;
  contentId: string;
  manifestEtag: string;
}

const CONTENT_SELECT = {
  id: true,
  groupId: true,
  sortOrder: true,
  frameName: true,
  contentEtag: true,
  imageEtag: true,
  audioEtag: true,
  imageSize: true,
  audioSize: true,
  audioStatus: true,
  audioSource: true,
  audioVoice: true,
  kind: true,
  dynamicType: true,
  dynamicNextRunAt: true,
  dynamicRefreshDueAt: true,
  dynamicConfig: true,
  dynamicData: true,
  dynamicLastRunAt: true,
  audioLastError: true,
  audioUpdatedAt: true,
} as const;

@Injectable()
export class ContentsService {
  private readonly logger = new Logger(ContentsService.name);
  private readonly dynamicMutationTails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly groups: GroupsService,
    private readonly imageRenderer: ImageRendererService,
    private readonly audio: AudioService,
    private readonly tts: TtsService,
    private readonly dynamicContentRegistry: DynamicContentRegistry,
    private readonly dynamicRenderer: DynamicContentRendererService,
    private readonly audioBlobs: ContentAudioBlobService
  ) {}

  async assertReadable(gid: string, scope: { userId?: string; deviceId?: string }): Promise<void> {
    if (scope.deviceId !== undefined && scope.userId === undefined) {
      const device = await this.prisma.device.findUnique({
        where: { id: scope.deviceId },
        select: {
          ownerUserId: true,
          selectedGroup: { select: { id: true, ownerUserId: true } },
        },
      });
      if (
        !device?.selectedGroup ||
        device.selectedGroup.id !== gid ||
        device.ownerUserId !== device.selectedGroup.ownerUserId
      ) {
        throw new NotFoundError('相册不存在');
      }
      return;
    }

    const group = await this.prisma.group.findUnique({
      where: { id: gid },
      select: { ownerUserId: true },
    });
    if (!group) throw new NotFoundError('相册不存在');
    if (scope.userId !== undefined) {
      if (group.ownerUserId !== scope.userId) throw new NotFoundError('相册不存在');
      return;
    }
    throw new NotFoundError('相册不存在');
  }

  async manifest(
    gid: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<ManifestResponseT & { manifestEtag: string }> {
    await this.assertReadable(gid, scope);
    const group = await this.prisma.group.findUnique({
      where: { id: gid },
      include: {
        contents: {
          orderBy: { sortOrder: 'asc' },
          select: CONTENT_SELECT,
        },
      },
    });
    if (!group) throw new NotFoundError('相册不存在');

    const peers = group.ownerUserId
      ? await this.prisma.group.findMany({
          where: { ownerUserId: group.ownerUserId },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { id: true },
        })
      : [{ id: group.id }];
    const idx = peers.findIndex((p) => p.id === group.id);

    return {
      group: {
        id: group.id,
        structure_etag: group.structureEtag,
        manifest_etag: group.manifestEtag,
        name: group.name,
        sort_order: group.sortOrder,
        position: {
          current: idx >= 0 ? idx + 1 : 1,
          total: Math.max(peers.length, 1),
        },
      },
      contents: group.contents.map((content) => contentToSummary(content)),
      manifestEtag: group.manifestEtag,
    };
  }

  async resolveCurrentContentRequest(
    deviceOrId: string,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined
  ): Promise<CurrentContentRequest | null>;
  async resolveCurrentContentRequest(
    deviceOrId: DevicePollSnapshot,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined
  ): Promise<CurrentContentRequest | null>;
  async resolveCurrentContentRequest(
    deviceOrId: string | DevicePollSnapshot,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined
  ): Promise<CurrentContentRequest | null> {
    const seq = telemetry?.current_content_seq;
    if (seq === undefined || !Number.isInteger(seq) || seq < 0) return null;
    const device =
      typeof deviceOrId === 'string'
        ? await this.prisma.device.findUnique({
            where: { id: deviceOrId },
            select: {
              id: true,
              selectedGroupId: true,
              selectedGroup: { select: { manifestEtag: true } },
            },
          })
        : deviceOrId;
    const groupId = device?.selectedGroupId;
    if (!groupId) return null;
    if (telemetry?.current_group && telemetry.current_group !== groupId) return null;
    if (!telemetry?.manifest_etag || telemetry.manifest_etag !== device.selectedGroup?.manifestEtag)
      return null;
    const content = await this.prisma.content.findUnique({
      where: { groupId_sortOrder: { groupId, sortOrder: seq } },
      select: { id: true },
    });
    if (!content) return null;
    return {
      deviceId: device.id,
      groupId,
      seq,
      contentId: content.id,
      manifestEtag: telemetry.manifest_etag,
    };
  }

  async currentContentForDevice(request: CurrentContentRequest): Promise<ContentSummaryT | null> {
    const content = await this.prisma.content.findUnique({
      where: { id: request.contentId },
      select: CONTENT_SELECT,
    });
    if (!content || content.groupId !== request.groupId || content.sortOrder !== request.seq) {
      return null;
    }
    return contentToSummary(content);
  }

  async refreshCurrentContentForDeviceIfDue(
    request: CurrentContentRequest | null
  ): Promise<CurrentContentRequest | null> {
    if (!request) return null;
    const device = await this.prisma.device.findUnique({
      where: { id: request.deviceId },
      select: { selectedGroupId: true, selectedGroup: { select: { manifestEtag: true } } },
    });
    if (
      !device ||
      device.selectedGroupId !== request.groupId ||
      device.selectedGroup?.manifestEtag !== request.manifestEtag
    ) {
      return null;
    }
    const content = await this.prisma.content.findUnique({
      where: { id: request.contentId },
      select: {
        id: true,
        groupId: true,
        sortOrder: true,
        kind: true,
        dynamicType: true,
        dynamicNextRunAt: true,
        dynamicRefreshDueAt: true,
      },
    });
    if (!content || content.groupId !== request.groupId || content.sortOrder !== request.seq) {
      return null;
    }
    if (this.isCurrentDynamicDue(content)) {
      try {
        const rendered = await this.dynamicRenderer.renderDynamicContent(content.id);
        return { ...request, manifestEtag: rendered.groupEtag };
      } catch (err) {
        this.logger.warn(
          `dynamic current-frame refresh failed content=${content.id}: ${formatError(err)}`
        );
      }
    }
    return request;
  }

  async list(
    gid: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<ContentDetailT[]> {
    await this.assertReadable(gid, scope);
    const rows = await this.prisma.content.findMany({
      where: { groupId: gid },
      orderBy: { sortOrder: 'asc' },
      select: {
        ...CONTENT_SELECT,
        dynamicLastError: true,
        audioText: true,
      },
    });
    return rows.map((row) => contentToDetail(row));
  }

  async get(
    contentId: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<ContentDetailT> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        ...CONTENT_SELECT,
        dynamicLastError: true,
        audioText: true,
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    await this.assertReadable(content.groupId, scope);
    return contentToDetail(content);
  }

  async readImage(
    contentId: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<{ data: Buffer; etag: string }> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { id: true, groupId: true, imageEtag: true },
    });
    if (!content) throw new NotFoundError('内容不存在');
    await this.assertReadable(content.groupId, scope);
    const data = await this.blob.read(content.groupId, content.id, 'image');
    if (!data) throw new NotFoundError('图片文件丢失');
    return { data, etag: content.imageEtag };
  }

  async readAudio(
    contentId: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<{ data: Buffer; etag: string }> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        groupId: true,
        audioEtag: true,
        audioSize: true,
        audioStatus: true,
        audioSource: true,
        audioText: true,
        audioVoice: true,
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    await this.assertReadable(content.groupId, scope);
    if (!content.audioEtag || !content.audioSize) throw new NotFoundError('该内容没有音频');
    const data = await this.audioBlobs.read(content.groupId, content.id, content.audioEtag);
    if (!data) {
      await this.audioBlobs.handleMissing(content);
      throw new NotFoundError('音频文件丢失');
    }
    return { data, etag: content.audioEtag };
  }

  async previewDynamicDirect(raw: {
    config: unknown;
    frame_name?: string | null;
    data?: unknown;
  }): Promise<Buffer> {
    const config = DynamicConfig.parse(raw.config);
    const previewData = this.parseDashboardPreviewData(config.type, raw.data);
    return this.dynamicRenderer.renderPreviewDirect(
      config.type,
      config,
      raw.frame_name ?? defaultDynamicFrameName(config.type, config),
      previewData
    );
  }

  async previewDynamic(
    contentId: string,
    ownerUserId: string,
    body: { config: unknown; frame_name?: string | null; data?: unknown }
  ): Promise<Buffer> {
    if (body.data === undefined) {
      return this.dynamicRenderer.renderPreview(
        contentId,
        ownerUserId,
        body.config,
        body.frame_name
      );
    }

    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        kind: true,
        dynamicType: true,
        frameName: true,
        group: { select: { ownerUserId: true } },
      },
    });
    if (!content || content.group.ownerUserId !== ownerUserId)
      throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic' || !content.dynamicType)
      throw new ValidationError('该内容不是动态类型');
    const config = DynamicConfig.parse(body.config);
    if (config.type !== content.dynamicType) {
      throw new ValidationError(
        `dynamic_type 与 config.type 不一致: ${content.dynamicType} vs ${config.type}`
      );
    }
    if (config.type !== 'dashboard') {
      throw new ValidationError('只有外部数据预览支持 data 参数');
    }
    const frameName = body.frame_name === undefined ? content.frameName : body.frame_name;
    const previewData = this.parseDashboardData(body.data, 'dashboard 预览数据不能为空');
    return this.dynamicRenderer.renderPreviewDirect(config.type, config, frameName, previewData);
  }

  private parseDashboardPreviewData(dynamicType: string, rawData: unknown): unknown {
    if (dynamicType !== 'dashboard') return undefined;
    return this.parseDashboardData(rawData, 'dashboard 预览数据不能为空');
  }

  private parseDashboardData(rawData: unknown, message: string): Record<string, unknown> {
    const parsed = DashboardDataPayload.safeParse(rawData);
    if (!parsed.success) {
      throw new ValidationError(message, { issues: parsed.error.issues });
    }
    return parsed.data;
  }

  async appendImage(
    gid: string,
    ownerUserId: string,
    parsed: ParsedContentUpload,
    signal?: AbortSignal
  ): Promise<ContentMutationResponseT> {
    await this.groups.assertOwned(gid, ownerUserId);
    if (!parsed.hasImage) throw new ValidationError('请上传图片', { code: 'image_required' });
    return this.createImage(gid, parsed, signal);
  }

  async appendDynamic(
    gid: string,
    ownerUserId: string,
    raw: CreateDynamicContentRequestT
  ): Promise<ContentMutationResponseT> {
    await this.groups.assertOwned(gid, ownerUserId);
    const { config, frame_name } = raw;
    const dynamic_type = config.type;
    const entry = this.dynamicContentRegistry.get(dynamic_type);
    if (!entry) throw new ValidationError(`未知动态类型: ${dynamic_type}`);
    const validatedConfig = DynamicConfig.parse(config);
    if (validatedConfig.type !== dynamic_type) {
      throw new ValidationError(
        `dynamic_type 与 config.type 不一致: ${dynamic_type} vs ${validatedConfig.type}`
      );
    }
    const initialDashboardData =
      validatedConfig.type === 'dashboard'
        ? this.parseDashboardData(raw.initial_data, 'dashboard 初始数据不能为空')
        : undefined;

    const contentId = createId();
    const placeholderEtag = computeETag(`dynamic-init:${contentId}`);
    const audioEnabled = isAudioDynamicConfig(validatedConfig) && validatedConfig.audio_enabled;
    const audioVoice = isAudioDynamicConfig(validatedConfig) ? validatedConfig.audio_voice : null;
    let created: { seq: number; didCreate: boolean } = { seq: -1, didCreate: false };
    try {
      const seq = await this.prisma.$transaction(async (tx) => {
        await lockGroupRow(tx, gid);
        const maxSeq = await tx.content.aggregate({
          where: { groupId: gid },
          _max: { sortOrder: true },
        });
        const nextSeq = (maxSeq._max.sortOrder ?? -1) + 1;
        await tx.content.create({
          data: {
            id: contentId,
            groupId: gid,
            sortOrder: nextSeq,
            frameName: frame_name ?? defaultDynamicFrameName(dynamic_type, validatedConfig),
            kind: 'dynamic',
            dynamicType: dynamic_type,
            dynamicConfig: validatedConfig as unknown as Prisma.InputJsonValue,
            ...(initialDashboardData === undefined
              ? {}
              : { dynamicData: initialDashboardData as Prisma.InputJsonValue }),
            imageEtag: placeholderEtag,
            imageSize: 0,
            audioStatus: audioEnabled ? 'pending' : 'none',
            audioSource: audioEnabled ? 'tts' : null,
            audioVoice: audioEnabled ? audioVoice : null,
            dynamicNextRunAt: new Date(0),
            dynamicRefreshDueAt: new Date(0),
          },
        });
        return nextSeq;
      });
      created = { seq, didCreate: true };
      const rendered = await this.renderDynamicAndReadEtag(contentId);
      return this.toMutationResponse(
        contentId,
        seq,
        rendered.imageEtag,
        null,
        rendered.groupEtag,
        rendered.contentEtag
      );
    } catch (err) {
      if (created.didCreate) {
        const stale = await this.prisma.content
          .findUnique({
            where: { id: contentId },
            select: { audioEtag: true },
          })
          .catch(() => null);
        let rollbackOk = true;
        let rollbackError: string | null = null;
        await this.prisma
          .$transaction(async (tx) => {
            await lockGroupRow(tx, gid);
            await tx.content.delete({ where: { id: contentId } });
            await this.compactSortOrders(tx, gid);
            await this.groups.recomputeManifestEtag(gid, tx);
          })
          .catch((rollbackErr: unknown) => {
            rollbackOk = false;
            rollbackError = formatError(rollbackErr);
            this.logger.warn(
              `创建动态内容失败后的 DB 回滚失败 content=${contentId}: ${rollbackError}`
            );
          });
        if (!rollbackOk) {
          throw new InternalError('创建动态内容失败，且 DB 回滚未完成', {
            code: 'dynamic_create_rollback_failed',
            original_error: formatError(err),
            rollback_error: rollbackError,
          });
        }
        const cleaned = await Promise.allSettled([
          this.blob.delete(gid, contentId, 'image'),
          this.audioBlobs.delete(gid, contentId, stale?.audioEtag ?? null),
        ]);
        const failed = cleaned.filter((result) => result.status === 'rejected').length;
        if (failed > 0) {
          this.logger.warn(
            `创建动态内容失败后的 blob 清理失败 content=${contentId}: ${failed} failure(s)`
          );
        }
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictError('内容序号已存在');
      throw err;
    }
  }

  async patchImage(
    contentId: string,
    ownerUserId: string,
    parsed: ParsedContentUpload
  ): Promise<ContentMutationResponseT> {
    const content = await this.requireContent(contentId);
    await this.groups.assertOwned(content.groupId, ownerUserId);
    if (content.kind !== 'image') {
      throw new ValidationError('动态内容请使用 JSON 更新');
    }
    return this.updateImage(
      content.groupId,
      content.sortOrder,
      contentId,
      parsed,
      content.audioEtag
    );
  }

  async patchDynamic(
    contentId: string,
    ownerUserId: string,
    body: { frame_name?: string | null; config?: unknown }
  ): Promise<ContentMutationResponseT> {
    if (body.frame_name === undefined && body.config === undefined) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }

    return this.runDynamicMutation(contentId, async () => {
      const content = await this.prisma.content.findUnique({
        where: { id: contentId },
        select: {
          id: true,
          groupId: true,
          sortOrder: true,
          kind: true,
          dynamicType: true,
          dynamicConfig: true,
        },
      });
      if (!content) throw new NotFoundError('内容不存在');
      if (content.kind !== 'dynamic' || !content.dynamicType)
        throw new ValidationError('该内容不是动态类型');
      await this.groups.assertOwned(content.groupId, ownerUserId);

      const data: Prisma.ContentUpdateInput = {};
      if (body.frame_name !== undefined) data.frameName = body.frame_name;
      if (body.config !== undefined) {
        const validated = DynamicConfig.parse(body.config);
        const currentType = content.dynamicType;
        if (validated.type !== currentType) {
          throw new ValidationError(
            `不能在已有动态内容上改 type（${currentType} → ${validated.type}），请删除后重建`
          );
        }
        data.dynamicConfig = validated as unknown as Prisma.InputJsonValue;
        data.dynamicRefreshDueAt = new Date();
        data.dynamicRefreshLeaseUntil = null;
        if (body.frame_name === undefined && currentType !== 'dashboard') {
          data.frameName = defaultDynamicFrameName(currentType, validated);
        }
      }
      await this.prisma.content.update({ where: { id: contentId }, data });
      const rendered = await this.renderDynamicAndReadEtag(contentId);
      return this.toMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        rendered.audioEtag,
        rendered.groupEtag,
        rendered.contentEtag
      );
    });
  }

  async patchFrameName(
    contentId: string,
    ownerUserId: string,
    frameName: string | null | undefined
  ): Promise<ContentMutationResponseT> {
    const content = await this.requireContent(contentId);
    await this.groups.assertOwned(content.groupId, ownerUserId);
    if (frameName === undefined) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }
    if (content.kind === 'dynamic') {
      const rendered = await this.runDynamicMutation(contentId, async () => {
        await this.prisma.content.update({ where: { id: contentId }, data: { frameName } });
        return this.renderDynamicAndReadEtag(contentId);
      });
      return this.toMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        rendered.audioEtag,
        rendered.groupEtag,
        rendered.contentEtag
      );
    }
    const { groupEtag, contentEtag } = await this.prisma.$transaction(async (tx) => {
      await lockGroupRow(tx, content.groupId);
      await tx.content.update({ where: { id: contentId }, data: { frameName } });
      const groupEtag = await this.groups.recomputeManifestEtag(content.groupId, tx);
      const contentEtag = await this.readContentEtag(contentId, tx);
      return { groupEtag, contentEtag };
    });
    return this.toMutationResponse(
      contentId,
      content.sortOrder,
      content.imageEtag,
      content.audioEtag,
      groupEtag,
      contentEtag
    );
  }

  async ingestDashboard(
    contentId: string,
    payload: IngestPayloadT
  ): Promise<ContentMutationResponseT & { updatedAt: Date }> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        sortOrder: true,
        kind: true,
        dynamicType: true,
      },
    });
    if (!content || content.kind !== 'dynamic' || content.dynamicType !== 'dashboard') {
      throw new NotFoundError('dashboard 内容不存在');
    }
    const rendered = await this.renderDynamicAndReadEtag(contentId, {
      force: true,
      dataOverride: payload.data,
    });
    return {
      ...this.toMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        rendered.audioEtag,
        rendered.groupEtag,
        rendered.contentEtag
      ),
      updatedAt: rendered.renderedAt,
    };
  }

  async refreshDynamicContent(
    contentId: string,
    ownerUserId: string
  ): Promise<ContentMutationResponseT & { updatedAt: Date }> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        groupId: true,
        sortOrder: true,
        kind: true,
        dynamicType: true,
        audioEtag: true,
        group: { select: { ownerUserId: true } },
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic' || !content.dynamicType)
      throw new ValidationError('非动态内容不支持手动刷新');
    if (content.group.ownerUserId !== ownerUserId) throw new NotFoundError('内容不存在');
    const rendered = await this.renderDynamicAndReadEtag(contentId);
    return {
      ...this.toMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        rendered.audioEtag,
        rendered.groupEtag,
        rendered.contentEtag
      ),
      updatedAt: rendered.renderedAt,
    };
  }

  async delete(contentId: string, ownerUserId: string): Promise<void> {
    const content = await this.requireContent(contentId);
    await this.groups.assertOwned(content.groupId, ownerUserId);
    await this.prisma.$transaction(async (tx) => {
      await lockGroupRow(tx, content.groupId);
      await tx.content.delete({ where: { id: contentId } });
      await this.compactSortOrders(tx, content.groupId);
      await this.groups.recomputeManifestEtag(content.groupId, tx);
    });
    const deleted = await Promise.allSettled([
      this.blob.delete(content.groupId, contentId, 'image'),
      this.audioBlobs.delete(content.groupId, contentId, content.audioEtag),
    ]);
    const failed = deleted.filter((result) => result.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(`content ${contentId} deleted with ${failed} blob cleanup failure(s)`);
    }
  }

  async deleteAudio(contentId: string, ownerUserId: string): Promise<{ manifest_etag: string }> {
    const content = await this.requireContent(contentId);
    await this.groups.assertOwned(content.groupId, ownerUserId);
    const previousAudioEtag = content.audioEtag;
    const manifest_etag = await this.prisma.$transaction(async (tx) => {
      await tx.content.update({
        where: { id: contentId },
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
      return this.groups.recomputeManifestEtag(content.groupId, tx);
    });
    await this.cleanupAudioBlobAfterCommit(content.groupId, contentId, previousAudioEtag);
    return { manifest_etag };
  }

  async generateImageTts(
    contentId: string,
    ownerUserId: string,
    raw: { text: string; voice: string }
  ): Promise<ContentMutationResponseT> {
    const content = await this.requireContent(contentId);
    if (content.kind !== 'image') throw new ValidationError('只有图片内容支持手动输入 TTS 文案');
    await this.groups.assertOwned(content.groupId, ownerUserId);
    const text = raw.text.trim();
    if (!text) throw new ValidationError('TTS 文案不能为空');
    if (text.length > 500) {
      throw new ValidationError('TTS 文案不能超过 500 字', {
        code: 'tts_text_too_long',
        max_chars: 500,
      });
    }
    const voice = this.tts.normalizeVoice(raw.voice);

    const previousAudioEtag = content.audioEtag;
    const { groupEtag, contentEtag } = await this.prisma.$transaction(async (tx) => {
      await tx.content.update({
        where: { id: contentId },
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
      const groupEtag = await this.groups.recomputeManifestEtag(content.groupId, tx);
      const contentEtag = await this.readContentEtag(contentId, tx);
      return { groupEtag, contentEtag };
    });
    await this.cleanupAudioBlobAfterCommit(content.groupId, contentId, previousAudioEtag);
    return this.toMutationResponse(
      contentId,
      content.sortOrder,
      content.imageEtag,
      null,
      groupEtag,
      contentEtag
    );
  }

  async reorder(
    gid: string,
    ownerUserId: string,
    order: string[]
  ): Promise<{ manifest_etag: string }> {
    await this.groups.assertOwned(gid, ownerUserId);
    const manifest_etag = await this.prisma.$transaction(async (tx) => {
      await lockGroupRow(tx, gid);
      const all = await tx.content.findMany({
        where: { groupId: gid },
        select: { id: true },
      });
      const allIds = new Set(all.map((content) => content.id));
      const orderSet = new Set(order);
      if (
        order.length !== allIds.size ||
        orderSet.size !== order.length ||
        !order.every((id) => allIds.has(id))
      ) {
        throw new ValidationError('排序列表须覆盖该组的所有内容且不重复', {
          code: 'order_mismatch',
        });
      }
      await bulkSetContentSortOrder(tx, gid, order);
      return this.groups.recomputeManifestEtag(gid, tx);
    });
    return { manifest_etag };
  }

  private async createImage(
    gid: string,
    parsed: ParsedContentUpload,
    signal?: AbortSignal
  ): Promise<ContentMutationResponseT> {
    const { image, audio } = await this.renderUpload(parsed, signal);
    if (!image) throw new ValidationError('创建图片内容时必须上传图片');
    const contentId = createId();
    const rollback = new BlobRollbackPlan(this.blob, this.logger);
    let mutation: { seq: number; groupEtag: string; contentEtag: string };
    try {
      rollback.deleteCreated(gid, contentId, 'image');
      await this.blob.write(gid, contentId, 'image', image.bytes);
      if (audio) {
        rollback.deleteCreated(gid, audioBlobContentId(contentId, audio.etag), 'audio');
        await this.blob.write(gid, audioBlobContentId(contentId, audio.etag), 'audio', audio.bytes);
      }
      mutation = await this.prisma.$transaction(async (tx) => {
        await lockGroupRow(tx, gid);
        const maxSeq = await tx.content.aggregate({
          where: { groupId: gid },
          _max: { sortOrder: true },
        });
        const nextSeq = (maxSeq._max.sortOrder ?? -1) + 1;
        await tx.content.create({
          data: {
            id: contentId,
            groupId: gid,
            sortOrder: nextSeq,
            frameName: parsed.hasFrameName ? parsed.frameName : null,
            imageEtag: image.etag,
            imageSize: image.size,
            audioEtag: audio?.etag ?? null,
            audioSize: audio?.size ?? null,
            audioStatus: audio ? 'ready' : 'none',
            audioSource: audio ? 'upload' : null,
            audioUpdatedAt: audio ? new Date() : null,
            audioLeaseUntil: null,
            audioAttempts: 0,
            kind: 'image',
          },
        });
        const groupEtag = await this.groups.recomputeManifestEtag(gid, tx);
        const contentEtag = await this.readContentEtag(contentId, tx);
        return { seq: nextSeq, groupEtag, contentEtag };
      });
    } catch (err) {
      await rollback.restoreAll();
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictError('内容序号已存在');
      throw err;
    }
    return this.toMutationResponse(
      contentId,
      mutation.seq,
      image.etag,
      audio?.etag ?? null,
      mutation.groupEtag,
      mutation.contentEtag
    );
  }

  private async updateImage(
    gid: string,
    seq: number,
    contentId: string,
    parsed: ParsedContentUpload,
    previousAudioEtag: string | null
  ): Promise<ContentMutationResponseT> {
    const data: Prisma.ContentUpdateInput = {};
    if (parsed.hasFrameName) data.frameName = parsed.frameName;
    if (parsed.hasFrameName === false && !parsed.hasImage && !parsed.hasAudio) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }
    const { image, audio } = await this.renderUpload(parsed);
    const previousImageBytes = image ? await this.blob.read(gid, contentId, 'image') : null;
    const shouldClearStaleAudio = Boolean(image && !audio && previousAudioEtag);

    const rollback = new BlobRollbackPlan(this.blob, this.logger);
    let dbUpdated = false;
    try {
      if (image) {
        rollback.restorePrevious(gid, contentId, 'image', previousImageBytes);
        await this.blob.write(gid, contentId, 'image', image.bytes);
        data.imageEtag = image.etag;
        data.imageSize = image.size;
        if (!audio && previousAudioEtag) {
          data.audioEtag = null;
          data.audioSize = null;
          data.audioStatus = 'none';
          data.audioSource = null;
          data.audioVoice = null;
          data.audioText = null;
          data.audioLastError = null;
          data.audioUpdatedAt = new Date();
          data.audioLeaseUntil = null;
          data.audioAttempts = 0;
        }
      }
      if (audio) {
        if (audio.etag !== previousAudioEtag) {
          rollback.deleteCreated(gid, audioBlobContentId(contentId, audio.etag), 'audio');
        }
        await this.blob.write(gid, audioBlobContentId(contentId, audio.etag), 'audio', audio.bytes);
        data.audioEtag = audio.etag;
        data.audioSize = audio.size;
        data.audioStatus = 'ready';
        data.audioSource = 'upload';
        data.audioVoice = null;
        data.audioText = null;
        data.audioLastError = null;
        data.audioUpdatedAt = new Date();
        data.audioLeaseUntil = null;
        data.audioAttempts = 0;
      }
      const { updated, groupEtag } = await this.prisma.$transaction(async (tx) => {
        await lockGroupRow(tx, gid);
        const updated = await tx.content.update({
          where: { id: contentId },
          data,
          select: { imageEtag: true, audioEtag: true, contentEtag: true },
        });
        const groupEtag = await this.groups.recomputeManifestEtag(gid, tx);
        return { updated, groupEtag };
      });
      dbUpdated = true;
      if (
        previousAudioEtag &&
        (audio || shouldClearStaleAudio) &&
        previousAudioEtag !== updated.audioEtag
      ) {
        await this.cleanupAudioBlobAfterCommit(gid, contentId, previousAudioEtag);
      }
      return this.toMutationResponse(
        contentId,
        seq,
        updated.imageEtag,
        updated.audioEtag,
        groupEtag,
        updated.contentEtag
      );
    } catch (err) {
      if (!dbUpdated) {
        await rollback.restoreAll();
      }
      throw err;
    }
  }

  private async renderUpload(
    parsed: ParsedContentUpload,
    signal?: AbortSignal
  ): Promise<{
    image: { bytes: Buffer; etag: string; size: number } | null;
    audio: { bytes: Buffer; etag: string; size: number } | null;
  }> {
    let image: { bytes: Buffer; etag: string; size: number } | null = null;
    if (parsed.hasImage && parsed.imageBuf) {
      const sourceEtag = computeETag(parsed.imageBuf);
      const rendered = await this.imageRenderer.renderTo1bpp(parsed.imageBuf, {
        threshold: parsed.threshold,
        mode: parsed.mode,
        sourceEtag,
      });
      this.imageRenderer.validateFrameSize(rendered.data);
      image = {
        bytes: rendered.data,
        etag: computeETag(rendered.data),
        size: rendered.data.byteLength,
      };
    }

    let audio: { bytes: Buffer; etag: string; size: number } | null = null;
    if (parsed.hasAudio && parsed.audioBuf) {
      const bytes = await this.audio.transcodeAudio(parsed.audioBuf, { signal });
      audio = { bytes, etag: computeETag(bytes), size: bytes.byteLength };
    }
    return { image, audio };
  }

  private async compactSortOrders(tx: Prisma.TransactionClient, gid: string): Promise<void> {
    const rows = await tx.content.findMany({
      where: { groupId: gid },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    await bulkSetContentSortOrder(
      tx,
      gid,
      rows.map((row) => row.id)
    );
  }

  private async requireContent(contentId: string): Promise<{
    id: string;
    groupId: string;
    sortOrder: number;
    kind: ContentKind;
    imageEtag: string;
    audioEtag: string | null;
    audioSource: ContentAudioSource | null;
  }> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        groupId: true,
        sortOrder: true,
        kind: true,
        imageEtag: true,
        audioEtag: true,
        audioSource: true,
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    return content;
  }

  private renderDynamicAndReadEtag(
    contentId: string,
    opts: Parameters<DynamicContentRendererService['renderDynamicContent']>[1] = { force: true }
  ): ReturnType<DynamicContentRendererService['renderDynamicContent']> {
    return this.dynamicRenderer.renderDynamicContent(contentId, opts);
  }

  private runDynamicMutation<T>(contentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.dynamicMutationTails.get(contentId) ?? Promise.resolve();
    // These are per-content mutation locks. A failed request should not block a later,
    // independent edit of the same dynamic content.
    const task = previous.then(fn, () => fn());
    this.dynamicMutationTails.set(contentId, task);
    void task
      .finally(() => {
        if (this.dynamicMutationTails.get(contentId) === task) {
          this.dynamicMutationTails.delete(contentId);
        }
      })
      .catch(() => undefined);
    return task;
  }

  private async cleanupAudioBlobAfterCommit(
    groupId: string,
    contentId: string,
    audioEtag: string | null
  ): Promise<void> {
    if (!audioEtag) return;
    await this.audioBlobs.delete(groupId, contentId, audioEtag).catch((err: unknown) => {
      this.logger.warn(
        `post-commit audio blob cleanup failed content=${contentId}: ${formatError(err)}`
      );
    });
  }

  private isCurrentDynamicDue(content: {
    kind: ContentKind;
    dynamicType: string | null;
    dynamicNextRunAt?: Date | null;
    dynamicRefreshDueAt?: Date | null;
  }): boolean {
    if (content.kind !== 'dynamic' || !content.dynamicType) return false;
    const dueAt = content.dynamicRefreshDueAt ?? content.dynamicNextRunAt ?? null;
    return dueAt !== null && dueAt.getTime() <= Date.now();
  }

  private toMutationResponse(
    contentId: string,
    seq: number,
    imageEtag: string,
    audioEtag: string | null,
    groupEtag: string,
    contentEtag: string
  ): ContentMutationResponseT {
    return {
      id: contentId,
      seq,
      content_etag: contentEtag,
      image_etag: imageEtag,
      audio_etag: audioEtag,
      manifest_etag: groupEtag,
    };
  }

  private async readContentEtag(
    contentId: string,
    client: PrismaClientLike = this.prisma
  ): Promise<string> {
    const row = await client.content.findUnique({
      where: { id: contentId },
      select: { contentEtag: true },
    });
    if (!row) throw new NotFoundError('内容不存在');
    return row.contentEtag;
  }
}
