import { createId } from '@paralleldrive/cuid2';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ContentAudioStatus, ContentKind } from '@prisma/client';
import {
  DynamicConfig,
  TTS_VOICES,
  TtsVoice,
  isAudioDynamicConfig,
  type ContentDetailT,
  type ContentMutationResponseT,
  type ContentSummaryT,
  type CreateDynamicContentRequestT,
  type DynamicConfigT,
  type DynamicTypeT,
  type ManifestResponseT,
} from 'shared';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { computeETag } from '../../common/etag/etag.util';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import { AudioService } from '../audio/audio.service';
import { audioBlobContentId } from '../audio/audio-blob-id';
import { TtsAudioCacheService, TtsService } from '../tts/tts.service';
import { GroupsService } from '../groups/groups.service';
import { ImageRendererService } from '../image-renderer/image-renderer.service';
import { DynamicContentRegistry } from '../dynamic-content/dynamic-content-registry';
import { DynamicContentRendererService } from '../dynamic-content/dynamic-content-renderer.service';
import type { RenderDynamicContentResult } from '../dynamic-content/dynamic-content-renderer.service';
import {
  deviceStatusBarText,
  fontTestStatusBarText,
  weatherStatusBarText,
} from './content-status-bar';
import type { ParsedContentUpload } from './multipart.parser';

type TtsVoiceValue = (typeof TTS_VOICES)[number];

interface ContentRow {
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
  audioSource: 'upload' | 'tts' | null;
  audioVoice: string | null;
  audioText?: string | null;
  audioLastError?: string | null;
  audioUpdatedAt?: Date | null;
  kind: ContentKind;
  dynamicType: string | null;
  dynamicNextRunAt?: Date | null;
  dynamicConfig?: Prisma.JsonValue | null;
  dynamicData?: Prisma.JsonValue | null;
  dynamicLastRunAt?: Date | null;
  dynamicLastError?: string | null;
}

type RenderDynamicContentResultExt = RenderDynamicContentResult & {
  contentEtag: string;
  audioEtag: string | null;
};

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly groups: GroupsService,
    private readonly imageRenderer: ImageRendererService,
    private readonly audio: AudioService,
    private readonly tts: TtsService,
    private readonly ttsCache: TtsAudioCacheService,
    private readonly dynamicContentRegistry: DynamicContentRegistry,
    private readonly dynamicRenderer: DynamicContentRendererService
  ) {}

  async assertReadable(gid: string, scope: { userId?: string; deviceId?: string }): Promise<void> {
    const group = await this.prisma.group.findUnique({
      where: { id: gid },
      select: { ownerUserId: true },
    });
    if (!group) throw new NotFoundError('相册不存在');
    if (scope.userId !== undefined) {
      if (group.ownerUserId !== scope.userId) throw new NotFoundError('相册不存在');
      return;
    }
    if (scope.deviceId !== undefined) {
      const device = await this.prisma.device.findUnique({
        where: { id: scope.deviceId },
        select: { selectedGroupId: true, ownerUserId: true },
      });
      if (!device || device.selectedGroupId !== gid || device.ownerUserId !== group.ownerUserId) {
        throw new NotFoundError('相册不存在');
      }
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
      contents: group.contents.map((content) => this.toSummary(content)),
      manifestEtag: group.manifestEtag,
    };
  }

  async currentContentForDevice(
    deviceId: string,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined
  ): Promise<ContentSummaryT | null> {
    const seq = telemetry?.current_content_seq;
    if (seq === undefined || !Number.isInteger(seq) || seq < 0) return null;
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { selectedGroupId: true, selectedGroup: { select: { manifestEtag: true } } },
    });
    const groupId = device?.selectedGroupId;
    if (!groupId) return null;
    if (telemetry?.current_group && telemetry.current_group !== groupId) return null;
    if (!telemetry?.manifest_etag || telemetry.manifest_etag !== device.selectedGroup?.manifestEtag)
      return null;
    const content = await this.prisma.content.findUnique({
      where: { groupId_sortOrder: { groupId, sortOrder: seq } },
      select: CONTENT_SELECT,
    });
    return content ? this.toSummary(content) : null;
  }

  async refreshCurrentContentForDeviceIfDue(
    deviceId: string,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined
  ): Promise<void> {
    const seq = telemetry?.current_content_seq;
    if (seq === undefined || !Number.isInteger(seq) || seq < 0) return;
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { selectedGroupId: true, selectedGroup: { select: { manifestEtag: true } } },
    });
    const groupId = device?.selectedGroupId;
    if (!groupId) return;
    if (telemetry?.current_group && telemetry.current_group !== groupId) return;
    if (!telemetry?.manifest_etag || telemetry.manifest_etag !== device.selectedGroup?.manifestEtag)
      return;
    const content = await this.prisma.content.findUnique({
      where: { groupId_sortOrder: { groupId, sortOrder: seq } },
      select: {
        id: true,
        kind: true,
        dynamicType: true,
        dynamicNextRunAt: true,
        dynamicRefreshDueAt: true,
      },
    });
    if (content && this.isCurrentDynamicDue(content)) {
      await this.dynamicRenderer.renderDynamicContent(content.id);
    }
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
        dynamicLastRunAt: true,
        dynamicLastError: true,
        audioText: true,
      },
    });
    return rows.map((row) => this.toDetail(row));
  }

  async get(
    contentId: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<ContentDetailT> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        ...CONTENT_SELECT,
        dynamicLastRunAt: true,
        dynamicLastError: true,
        audioText: true,
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    await this.assertReadable(content.groupId, scope);
    return this.toDetail(content);
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
    const data = await this.readAudioBlob(content);
    if (!data) {
      await this.handleMissingAudioBlob(content);
      throw new NotFoundError('音频文件丢失');
    }
    return { data, etag: content.audioEtag };
  }

  async previewDynamicDirect(raw: {
    config: unknown;
    frame_name?: string | null;
  }): Promise<Buffer> {
    const config = DynamicConfig.parse(raw.config);
    return this.dynamicRenderer.renderPreviewDirect(
      config.type,
      config,
      raw.frame_name ?? defaultFrameName(config.type, config)
    );
  }

  async previewDynamic(
    contentId: string,
    ownerUserId: string,
    body: { config: unknown; frame_name?: string | null }
  ): Promise<Buffer> {
    return this.dynamicRenderer.renderPreview(contentId, ownerUserId, body.config, body.frame_name);
  }

  async appendImage(
    gid: string,
    ownerUserId: string,
    parsed: ParsedContentUpload
  ): Promise<ContentMutationResponseT> {
    await this.groups.assertOwned(gid, ownerUserId);
    if (!parsed.hasImage) throw new ValidationError('请上传图片', { code: 'image_required' });
    return this.createImage(gid, parsed);
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

    const contentId = createId();
    const placeholderEtag = computeETag(`dynamic-init:${contentId}`);
    const audioEnabled = isAudioDynamicConfig(validatedConfig) && validatedConfig.audio_enabled;
    const audioVoice = isAudioDynamicConfig(validatedConfig) ? validatedConfig.audio_voice : null;
    let created: { seq: number; didCreate: boolean } = { seq: -1, didCreate: false };
    try {
      const seq = await this.prisma.$transaction(async (tx) => {
        await this.lockGroupForContentOrder(tx, gid);
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
            frameName: frame_name ?? defaultFrameName(dynamic_type, validatedConfig),
            kind: 'dynamic',
            dynamicType: dynamic_type,
            dynamicConfig: validatedConfig as unknown as Prisma.InputJsonValue,
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
      await this.blob.delete(gid, contentId, 'image').catch(() => {});
      if (created.didCreate) {
        await this.prisma
          .$transaction(async (tx) => {
            await this.lockGroupForContentOrder(tx, gid);
            await tx.content.delete({ where: { id: contentId } });
            await this.compactSortOrders(tx, gid);
            await this.groups.recomputeManifestEtag(gid, tx);
          })
          .catch((rollbackErr: unknown) => {
            this.logger.warn(
              `创建动态内容失败后的 DB 回滚失败 content=${contentId}: ${formatError(rollbackErr)}`
            );
          });
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
      content.audioEtag,
      content.audioSource
    );
  }

  async patchDynamic(
    contentId: string,
    ownerUserId: string,
    body: { frame_name?: string | null; config?: unknown }
  ): Promise<ContentMutationResponseT> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        groupId: true,
        sortOrder: true,
        kind: true,
        dynamicType: true,
        audioEtag: true,
        audioStatus: true,
        audioSource: true,
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic' || !content.dynamicType)
      throw new ValidationError('该内容不是动态类型');
    await this.groups.assertOwned(content.groupId, ownerUserId);
    if (body.frame_name === undefined && body.config === undefined) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }

    const data: Prisma.ContentUpdateInput = {};
    let configChanged = false;
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
      configChanged = true;
      if (body.frame_name === undefined && currentType !== 'dashboard') {
        data.frameName = defaultFrameName(currentType, validated);
      }
    }
    await this.prisma.content.update({ where: { id: contentId }, data });
    if (configChanged) {
      const rendered = await this.renderDynamicAndReadEtag(contentId);
      return this.toMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        rendered.audioEtag,
        rendered.groupEtag,
        rendered.contentEtag
      );
    }
    const rendered = await this.renderDynamicAndReadEtag(contentId);
    return this.toMutationResponse(
      contentId,
      content.sortOrder,
      rendered.imageEtag,
      rendered.audioEtag,
      rendered.groupEtag,
      rendered.contentEtag
    );
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
    await this.prisma.content.update({ where: { id: contentId }, data: { frameName } });
    if (content.kind === 'dynamic') {
      const rendered = await this.renderDynamicAndReadEtag(contentId);
      return this.toMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        rendered.audioEtag,
        rendered.groupEtag,
        rendered.contentEtag
      );
    }
    const groupEtag = await this.groups.recomputeManifestEtag(content.groupId);
    const contentEtag = await this.readContentEtag(contentId);
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
    data: unknown
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
      },
    });
    if (!content || content.kind !== 'dynamic' || content.dynamicType !== 'dashboard') {
      throw new NotFoundError('dashboard 内容不存在');
    }
    const rendered = await this.renderDynamicAndReadEtag(contentId, {
      force: true,
      dataOverride: data,
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
    const previousImage = await this.blob.read(content.groupId, contentId, 'image');
    const previousAudio =
      content.audioSource === 'upload'
        ? await this.readOwnedAudioBlob(content.groupId, contentId, content.audioEtag)
        : null;
    await Promise.all([
      this.blob.delete(content.groupId, contentId, 'image'),
      this.deleteOwnedAudioBlob(content.groupId, contentId, content.audioEtag, content.audioSource),
    ]);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockGroupForContentOrder(tx, content.groupId);
        await tx.content.delete({ where: { id: contentId } });
        await this.compactSortOrders(tx, content.groupId);
        await this.groups.recomputeManifestEtag(content.groupId, tx);
      });
    } catch (err) {
      if (previousImage)
        await this.blob.write(content.groupId, contentId, 'image', previousImage).catch(() => {});
      if (previousAudio && content.audioEtag) {
        await this.blob
          .write(
            content.groupId,
            audioBlobContentId(contentId, content.audioEtag),
            'audio',
            previousAudio
          )
          .catch(() => {});
      }
      throw err;
    }
  }

  async deleteAudio(contentId: string, ownerUserId: string): Promise<{ manifest_etag: string }> {
    const content = await this.requireContent(contentId);
    await this.groups.assertOwned(content.groupId, ownerUserId);
    const previousAudioEtag = content.audioEtag;
    const previousAudioBytes =
      content.audioSource === 'upload'
        ? await this.readOwnedAudioBlob(content.groupId, contentId, previousAudioEtag)
        : null;
    try {
      await this.prisma.content.update({
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
      const manifest_etag = await this.groups.recomputeManifestEtag(content.groupId);
      await this.deleteOwnedAudioBlob(
        content.groupId,
        contentId,
        previousAudioEtag,
        content.audioSource
      );
      return { manifest_etag };
    } catch (err) {
      if (previousAudioBytes && previousAudioEtag) {
        await this.blob
          .write(
            content.groupId,
            audioBlobContentId(contentId, previousAudioEtag),
            'audio',
            previousAudioBytes
          )
          .catch((restoreErr: unknown) => {
            this.logger.warn(`恢复音频文件失败 content=${contentId}: ${String(restoreErr)}`);
          });
      }
      throw err;
    }
  }

  async generateImageTts(
    contentId: string,
    ownerUserId: string,
    raw: { text: string; voice: string }
  ): Promise<ContentMutationResponseT> {
    const content = await this.requireContent(contentId);
    if (content.kind !== 'image') throw new ValidationError('只有图片内容支持手动输入 TTS 文案');
    await this.groups.assertOwned(content.groupId, ownerUserId);
    const text = raw.text.trim().slice(0, 500);
    if (!text) throw new ValidationError('TTS 文案不能为空');
    const voice = this.tts.normalizeVoice(raw.voice);

    const previousAudioEtag = content.audioEtag;
    await this.prisma.content.update({
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
    const groupEtag = await this.groups.recomputeManifestEtag(content.groupId);
    await this.deleteOwnedAudioBlob(
      content.groupId,
      contentId,
      previousAudioEtag,
      content.audioSource
    );
    const contentEtag = await this.readContentEtag(contentId);
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
      await this.lockGroupForContentOrder(tx, gid);
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
      await bulkSetContentSortOrders(tx, gid, order);
      return this.groups.recomputeManifestEtag(gid, tx);
    });
    return { manifest_etag };
  }

  private toSummary(row: ContentRow): ContentSummaryT {
    // DB 字段已经由 schema 收口，列表场景不必每行 zod parse —— 直接断言。
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

  private toDetail(
    row: ContentRow & {
      groupId: string;
      dynamicLastRunAt?: Date | null;
      dynamicLastError?: string | null;
    }
  ): ContentDetailT {
    const config = row.dynamicConfig ? DynamicConfig.safeParse(row.dynamicConfig) : null;
    return {
      ...this.toSummary(row),
      group_id: row.groupId,
      dynamic_config: config?.success
        ? config.data
        : ((row.dynamicConfig as DynamicConfigT | null) ?? null),
      dynamic_data: row.dynamicData ?? null,
      dynamic_last_rendered_at: row.dynamicLastRunAt?.toISOString() ?? null,
      dynamic_next_render_at: row.dynamicNextRunAt?.toISOString() ?? null,
      dynamic_render_error: row.dynamicLastError ?? null,
      audio_text: row.audioText ?? null,
      audio_error: row.audioLastError ?? null,
      audio_updated_at: row.audioUpdatedAt?.toISOString() ?? null,
    };
  }

  private async createImage(
    gid: string,
    parsed: ParsedContentUpload
  ): Promise<ContentMutationResponseT> {
    const { image, audio } = await this.renderUpload(parsed);
    if (!image) throw new ValidationError('创建图片内容时必须上传图片');
    const contentId = createId();
    let seq: number;
    try {
      await this.blob.write(gid, contentId, 'image', image.bytes);
      if (audio)
        await this.blob.write(gid, audioBlobContentId(contentId, audio.etag), 'audio', audio.bytes);
      seq = await this.prisma.$transaction(async (tx) => {
        await this.lockGroupForContentOrder(tx, gid);
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
        return nextSeq;
      });
    } catch (err) {
      await Promise.all([
        this.blob.delete(gid, contentId, 'image').catch(() => {}),
        audio
          ? this.blob
              .delete(gid, audioBlobContentId(contentId, audio.etag), 'audio')
              .catch(() => {})
          : Promise.resolve(),
      ]);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictError('内容序号已存在');
      throw err;
    }
    const groupEtag = await this.groups.recomputeManifestEtag(gid);
    const contentEtag = await this.readContentEtag(contentId);
    return this.toMutationResponse(
      contentId,
      seq,
      image.etag,
      audio?.etag ?? null,
      groupEtag,
      contentEtag
    );
  }

  private async updateImage(
    gid: string,
    seq: number,
    contentId: string,
    parsed: ParsedContentUpload,
    previousAudioEtag: string | null,
    previousAudioSource: 'upload' | 'tts' | null
  ): Promise<ContentMutationResponseT> {
    const { image, audio } = await this.renderUpload(parsed);
    const data: Prisma.ContentUpdateInput = {};
    if (parsed.hasFrameName) data.frameName = parsed.frameName;
    const previousImageBytes = image ? await this.blob.read(gid, contentId, 'image') : null;
    const shouldClearStaleAudio = Boolean(image && !audio && previousAudioEtag);
    const previousAudioBytes =
      previousAudioSource === 'upload' && (audio || shouldClearStaleAudio)
        ? await this.readOwnedAudioBlob(gid, contentId, previousAudioEtag)
        : null;
    if (parsed.hasFrameName === false && !image && !audio) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }

    let dbUpdated = false;
    try {
      if (image) {
        await this.blob.write(gid, contentId, 'image', image.bytes);
        data.imageEtag = image.etag;
        data.imageSize = image.size;
        if (!audio) {
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
      const updated = await this.prisma.content.update({
        where: { id: contentId },
        data,
        select: { imageEtag: true, audioEtag: true },
      });
      dbUpdated = true;
      const groupEtag = await this.groups.recomputeManifestEtag(gid);
      if (audio || shouldClearStaleAudio) {
        await this.deleteOwnedAudioBlob(gid, contentId, previousAudioEtag, previousAudioSource);
      }
      const contentEtag = await this.readContentEtag(contentId);
      return this.toMutationResponse(
        contentId,
        seq,
        updated.imageEtag,
        updated.audioEtag,
        groupEtag,
        contentEtag
      );
    } catch (err) {
      if (!dbUpdated) {
        await Promise.all([
          restoreBlob(
            this.blob,
            gid,
            contentId,
            'image',
            previousImageBytes,
            Boolean(image),
            this.logger
          ).catch(() => {}),
          restoreBlob(
            this.blob,
            gid,
            audio ? audioBlobContentId(contentId, audio.etag) : contentId,
            'audio',
            null,
            Boolean(audio),
            this.logger
          ).catch(() => {}),
          previousAudioSource === 'upload' &&
          previousAudioEtag &&
          (audio || shouldClearStaleAudio) &&
          previousAudioBytes
            ? this.blob
                .write(
                  gid,
                  audioBlobContentId(contentId, previousAudioEtag),
                  'audio',
                  previousAudioBytes
                )
                .catch(() => {})
            : Promise.resolve(),
        ]);
      }
      throw err;
    }
  }

  private async renderUpload(parsed: ParsedContentUpload): Promise<{
    image: { bytes: Buffer; etag: string; size: number } | null;
    audio: { bytes: Buffer; etag: string; size: number } | null;
  }> {
    let image: { bytes: Buffer; etag: string; size: number } | null = null;
    if (parsed.hasImage && parsed.imageBuf) {
      const rendered = await this.imageRenderer.renderTo1bpp(parsed.imageBuf, {
        threshold: parsed.threshold,
        mode: parsed.mode,
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
      const bytes = await this.audio.transcodeAudio(parsed.audioBuf);
      audio = { bytes, etag: computeETag(bytes), size: bytes.byteLength };
    }
    return { image, audio };
  }

  private async lockGroupForContentOrder(tx: Prisma.TransactionClient, gid: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM \`groups\` WHERE id = ${gid} FOR UPDATE
    `;
    if (rows.length === 0) throw new NotFoundError('相册不存在');
  }

  private async compactSortOrders(tx: Prisma.TransactionClient, gid: string): Promise<void> {
    const rows = await tx.content.findMany({
      where: { groupId: gid },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    await bulkSetContentSortOrders(
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
    audioSource: 'upload' | 'tts' | null;
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

  private async renderDynamicAndReadEtag(
    contentId: string,
    opts: Parameters<DynamicContentRendererService['renderDynamicContent']>[1] = { force: true }
  ): Promise<RenderDynamicContentResultExt> {
    const rendered = await this.dynamicRenderer.renderDynamicContent(contentId, opts);
    const row = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { contentEtag: true, audioEtag: true },
    });
    if (!row) throw new NotFoundError('内容不存在');
    return { ...rendered, contentEtag: row.contentEtag, audioEtag: row.audioEtag };
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

  private async clearContentAudio(
    content: {
      id: string;
      groupId: string;
      audioEtag: string | null;
      audioStatus: ContentAudioStatus;
      audioSource: 'upload' | 'tts' | null;
    },
    status: 'none' | 'failed'
  ): Promise<void> {
    if (!content.audioEtag && content.audioStatus === status) return;
    const previousAudioEtag = content.audioEtag;
    await this.prisma.content.update({
      where: { id: content.id },
      data: {
        audioEtag: null,
        audioSize: null,
        audioStatus: status,
        audioSource: status === 'failed' ? content.audioSource : null,
        audioVoice: null,
        audioText: null,
        audioLastError: status === 'failed' ? '音频文件丢失，请重新上传' : null,
        audioUpdatedAt: new Date(),
        audioLeaseUntil: null,
        audioAttempts: 0,
      },
    });
    await this.deleteOwnedAudioBlob(
      content.groupId,
      content.id,
      previousAudioEtag,
      content.audioSource
    );
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

  private async readContentEtag(contentId: string): Promise<string> {
    const row = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { contentEtag: true },
    });
    if (!row) throw new NotFoundError('内容不存在');
    return row.contentEtag;
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

  private async deleteOwnedAudioBlob(
    groupId: string,
    contentId: string,
    audioEtag: string | null,
    audioSource?: 'upload' | 'tts' | null
  ): Promise<void> {
    if (audioSource === 'tts') return;
    await this.deleteAudioBlob(groupId, contentId, audioEtag);
  }

  private async readAudioBlob(content: {
    id: string;
    groupId: string;
    audioEtag: string | null;
    audioSource?: 'upload' | 'tts' | null;
  }): Promise<Buffer | null> {
    if (!content.audioEtag) return null;
    if (content.audioSource === 'tts') {
      return this.ttsCache.readByEtag(content.audioEtag);
    }
    return this.readOwnedAudioBlob(content.groupId, content.id, content.audioEtag);
  }

  private async readOwnedAudioBlob(
    groupId: string,
    contentId: string,
    audioEtag: string | null
  ): Promise<Buffer | null> {
    if (!audioEtag) return null;
    return this.blob.read(groupId, audioBlobContentId(contentId, audioEtag), 'audio');
  }

  private async handleMissingAudioBlob(content: {
    id: string;
    groupId: string;
    audioEtag: string | null;
    audioStatus: ContentAudioStatus;
    audioSource: 'upload' | 'tts' | null;
    audioText: string | null;
    audioVoice: string | null;
  }): Promise<void> {
    if (!content.audioEtag) return;
    if (content.audioSource === 'tts' && content.audioText && content.audioVoice) {
      await this.prisma.content.update({
        where: { id: content.id },
        data: {
          audioEtag: null,
          audioSize: null,
          audioStatus: 'pending',
          audioLastError: 'TTS 音频文件丢失，已重新排队',
          audioUpdatedAt: new Date(),
          audioLeaseUntil: null,
        },
      });
    } else {
      await this.prisma.content.update({
        where: { id: content.id },
        data: {
          audioEtag: null,
          audioSize: null,
          audioStatus: content.audioSource === 'upload' ? 'failed' : 'none',
          audioSource: content.audioSource === 'upload' ? 'upload' : null,
          audioLastError: content.audioSource === 'upload' ? '上传音频文件丢失，请重新上传' : null,
          audioUpdatedAt: new Date(),
          audioLeaseUntil: null,
        },
      });
    }
    await this.groups.recomputeManifestEtag(content.groupId);
  }
}

function nextWakeSec(nextRunAt: Date | null): number | null {
  if (!nextRunAt) return null;
  return Math.max(Math.ceil((nextRunAt.getTime() - Date.now()) / 1000), 0);
}

function defaultFrameName(dynamicType: string | null, config?: unknown): string | null {
  switch (dynamicType) {
    case 'daily_calendar':
      return '日历';
    case 'month_calendar':
      return '月历';
    case 'history_today':
      return '历史上的今天';
    case 'weather':
      return weatherStatusBarText(config);
    case 'dashboard':
      return '数据看板';
    case 'font_test':
      return fontTestStatusBarText(config);
    default:
      return null;
  }
}

async function bulkSetContentSortOrders(
  tx: Prisma.TransactionClient,
  groupId: string,
  order: string[]
): Promise<void> {
  if (order.length === 0) return;
  const ids = Prisma.join(order);
  await tx.$executeRaw`
    UPDATE \`contents\`
    SET \`sort_order\` = CASE \`id\`
      ${Prisma.join(
        order.map((id, idx) => Prisma.sql`WHEN ${id} THEN ${-(idx + 1)}`),
        ' '
      )}
    END
    WHERE \`group_id\` = ${groupId} AND \`id\` IN (${ids})
  `;
  await tx.$executeRaw`
    UPDATE \`contents\`
    SET \`sort_order\` = CASE \`id\`
      ${Prisma.join(
        order.map((id, idx) => Prisma.sql`WHEN ${id} THEN ${idx}`),
        ' '
      )}
    END
    WHERE \`group_id\` = ${groupId} AND \`id\` IN (${ids})
  `;
}

async function restoreBlob(
  blob: BlobService,
  groupId: string,
  contentId: string,
  kind: 'image' | 'audio',
  previousBytes: Buffer | null,
  touched: boolean,
  logger: Logger
): Promise<void> {
  if (!touched) return;
  try {
    if (previousBytes) await blob.write(groupId, contentId, kind, previousBytes);
    else await blob.delete(groupId, contentId, kind);
  } catch (err) {
    logger.warn(`恢复 ${kind} blob 失败 content=${contentId}: ${formatError(err)}`);
    throw err;
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
