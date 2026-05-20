import { createId } from '@paralleldrive/cuid2';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ContentKind } from '@prisma/client';
import {
  DynamicConfig,
  FONT_TEST_FONTS,
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
import { GroupsService } from '../groups/groups.service';
import { ImageRendererService } from '../image-renderer/image-renderer.service';
import { DynamicContentRegistry } from '../dynamic-content/dynamic-content-registry';
import { DynamicContentRendererService } from '../dynamic-content/dynamic-content-renderer.service';
import { datePartsInTz, timezoneFromConfig } from '../dynamic-content/timezone';
import type { ParsedContentUpload } from './multipart.parser';

interface ContentRow {
  id: string;
  groupId?: string;
  sortOrder: number;
  frameName: string | null;
  imageEtag: string;
  audioEtag: string | null;
  imageSize: number;
  audioSize: number | null;
  kind: ContentKind;
  dynamicType: string | null;
  dynamicNextRunAt?: Date | null;
  dynamicConfig?: Prisma.JsonValue | null;
  dynamicData?: Prisma.JsonValue | null;
  dynamicLastRunAt?: Date | null;
  dynamicLastError?: string | null;
}

interface StatusBarTextSource {
  kind: ContentKind;
  frameName: string | null;
  dynamicType: string | null;
  dynamicConfig?: Prisma.JsonValue | null;
  dynamicData?: Prisma.JsonValue | null;
}

const CONTENT_SELECT = {
  id: true,
  groupId: true,
  sortOrder: true,
  frameName: true,
  imageEtag: true,
  audioEtag: true,
  imageSize: true,
  audioSize: true,
  kind: true,
  dynamicType: true,
  dynamicNextRunAt: true,
  dynamicConfig: true,
  dynamicData: true,
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
  ): Promise<ManifestResponseT & { etag: string }> {
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
        etag: group.etag,
        name: group.name,
        sort_order: group.sortOrder,
        position: {
          current: idx >= 0 ? idx + 1 : 1,
          total: Math.max(peers.length, 1),
        },
      },
      contents: group.contents.map((content) => this.toSummary(content)),
      etag: group.etag,
    };
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
      select: { id: true, groupId: true, audioEtag: true, audioSize: true },
    });
    if (!content) throw new NotFoundError('内容不存在');
    await this.assertReadable(content.groupId, scope);
    if (!content.audioEtag || !content.audioSize) throw new NotFoundError('该内容没有音频');
    const data = await this.blob.read(content.groupId, content.id, 'audio');
    if (!data) throw new NotFoundError('音频文件丢失');
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
            dynamicNextRunAt: new Date(0),
          },
        });
        return nextSeq;
      });
      created = { seq, didCreate: true };
      const rendered = await this.dynamicRenderer.renderDynamicContent(contentId, { force: true });
      return this.toMutationResponse(contentId, seq, rendered.imageEtag, null, rendered.groupEtag);
    } catch (err) {
      await this.blob.delete(gid, contentId, 'image').catch(() => {});
      if (created.didCreate) {
        await this.prisma
          .$transaction(async (tx) => {
            await this.lockGroupForContentOrder(tx, gid);
            await tx.content.delete({ where: { id: contentId } });
            await this.compactSortOrders(tx, gid);
            await this.groups.recomputeGroupEtag(gid, tx);
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
    if (content.kind !== 'image' && (parsed.hasImage || parsed.hasAudio)) {
      throw new ValidationError('动态内容由服务端生成，不支持上传图片或音频');
    }
    return this.updateImage(content.groupId, content.sortOrder, contentId, parsed);
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
      if (body.frame_name === undefined && currentType !== 'dashboard') {
        data.frameName = defaultFrameName(currentType, validated);
      }
    }
    await this.prisma.content.update({ where: { id: contentId }, data });
    const rendered = await this.dynamicRenderer.renderDynamicContent(contentId, { force: true });
    return this.toMutationResponse(
      contentId,
      content.sortOrder,
      rendered.imageEtag,
      content.audioEtag,
      rendered.groupEtag
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
      const rendered = await this.dynamicRenderer.renderDynamicContent(contentId, { force: true });
      return this.toMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        content.audioEtag,
        rendered.groupEtag
      );
    }
    const groupEtag = await this.groups.recomputeGroupEtag(content.groupId);
    return this.toMutationResponse(
      contentId,
      content.sortOrder,
      content.imageEtag,
      content.audioEtag,
      groupEtag
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
    const rendered = await this.dynamicRenderer.renderDynamicContent(contentId, {
      force: true,
      dataOverride: data,
    });
    return {
      ...this.toMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        content.audioEtag,
        rendered.groupEtag
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
    const rendered = await this.dynamicRenderer.renderDynamicContent(contentId, { force: true });
    return {
      ...this.toMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        content.audioEtag,
        rendered.groupEtag
      ),
      updatedAt: rendered.renderedAt,
    };
  }

  async delete(contentId: string, ownerUserId: string): Promise<void> {
    const content = await this.requireContent(contentId);
    await this.groups.assertOwned(content.groupId, ownerUserId);
    const previousImage = await this.blob.read(content.groupId, contentId, 'image');
    const previousAudio = await this.blob.read(content.groupId, contentId, 'audio');
    await Promise.all([
      this.blob.delete(content.groupId, contentId, 'image'),
      this.blob.delete(content.groupId, contentId, 'audio'),
    ]);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockGroupForContentOrder(tx, content.groupId);
        await tx.content.delete({ where: { id: contentId } });
        await this.compactSortOrders(tx, content.groupId);
        await this.groups.recomputeGroupEtag(content.groupId, tx);
      });
    } catch (err) {
      if (previousImage)
        await this.blob.write(content.groupId, contentId, 'image', previousImage).catch(() => {});
      if (previousAudio)
        await this.blob.write(content.groupId, contentId, 'audio', previousAudio).catch(() => {});
      throw err;
    }
  }

  async deleteAudio(contentId: string, ownerUserId: string): Promise<{ group_etag: string }> {
    const content = await this.requireContent(contentId);
    await this.groups.assertOwned(content.groupId, ownerUserId);
    const previousAudioBytes = await this.blob.read(content.groupId, contentId, 'audio');
    await this.blob.delete(content.groupId, contentId, 'audio');
    try {
      await this.prisma.content.update({
        where: { id: contentId },
        data: { audioEtag: null, audioSize: null },
      });
      const group_etag = await this.groups.recomputeGroupEtag(content.groupId);
      return { group_etag };
    } catch (err) {
      if (previousAudioBytes) {
        await this.blob
          .write(content.groupId, contentId, 'audio', previousAudioBytes)
          .catch((restoreErr: unknown) => {
            this.logger.warn(`恢复音频文件失败 content=${contentId}: ${String(restoreErr)}`);
          });
      }
      throw err;
    }
  }

  async reorder(
    gid: string,
    ownerUserId: string,
    order: string[]
  ): Promise<{ group_etag: string }> {
    await this.groups.assertOwned(gid, ownerUserId);
    const group_etag = await this.prisma.$transaction(async (tx) => {
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
      for (let i = 0; i < order.length; i++) {
        await tx.content.update({ where: { id: order[i]! }, data: { sortOrder: -(i + 1) } });
      }
      for (let i = 0; i < order.length; i++) {
        await tx.content.update({ where: { id: order[i]! }, data: { sortOrder: i } });
      }
      return this.groups.recomputeGroupEtag(gid, tx);
    });
    return { group_etag };
  }

  private toSummary(row: ContentRow): ContentSummaryT {
    // DB 字段已经由 schema 收口，列表场景不必每行 zod parse —— 直接断言。
    return {
      id: row.id,
      seq: row.sortOrder,
      frame_name: row.frameName,
      device_status_bar_text: deviceStatusBarText(row),
      image_etag: row.imageEtag,
      audio_etag: row.audioEtag,
      image_size: row.imageSize,
      audio_size: row.audioSize,
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
    return {
      ...this.toSummary(row),
      group_id: row.groupId,
      dynamic_config: (row.dynamicConfig as DynamicConfigT | null) ?? null,
      dynamic_data: row.dynamicData ?? null,
      dynamic_last_rendered_at: row.dynamicLastRunAt?.toISOString() ?? null,
      dynamic_next_render_at: row.dynamicNextRunAt?.toISOString() ?? null,
      dynamic_render_error: row.dynamicLastError ?? null,
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
      if (audio) await this.blob.write(gid, contentId, 'audio', audio.bytes);
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
            kind: 'image',
          },
        });
        return nextSeq;
      });
    } catch (err) {
      await Promise.all([
        this.blob.delete(gid, contentId, 'image').catch(() => {}),
        this.blob.delete(gid, contentId, 'audio').catch(() => {}),
      ]);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictError('内容序号已存在');
      throw err;
    }
    const groupEtag = await this.groups.recomputeGroupEtag(gid);
    return this.toMutationResponse(contentId, seq, image.etag, audio?.etag ?? null, groupEtag);
  }

  private async updateImage(
    gid: string,
    seq: number,
    contentId: string,
    parsed: ParsedContentUpload
  ): Promise<ContentMutationResponseT> {
    const { image, audio } = await this.renderUpload(parsed);
    const data: Prisma.ContentUpdateInput = {};
    if (parsed.hasFrameName) data.frameName = parsed.frameName;
    const previousImageBytes = image ? await this.blob.read(gid, contentId, 'image') : null;
    const previousAudioBytes = audio ? await this.blob.read(gid, contentId, 'audio') : null;
    if (parsed.hasFrameName === false && !image && !audio) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }

    let dbUpdated = false;
    try {
      if (image) {
        await this.blob.write(gid, contentId, 'image', image.bytes);
        data.imageEtag = image.etag;
        data.imageSize = image.size;
      }
      if (audio) {
        await this.blob.write(gid, contentId, 'audio', audio.bytes);
        data.audioEtag = audio.etag;
        data.audioSize = audio.size;
      }
      const updated = await this.prisma.content.update({
        where: { id: contentId },
        data,
        select: { imageEtag: true, audioEtag: true },
      });
      dbUpdated = true;
      const groupEtag = await this.groups.recomputeGroupEtag(gid);
      return this.toMutationResponse(
        contentId,
        seq,
        updated.imageEtag,
        updated.audioEtag,
        groupEtag
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
            contentId,
            'audio',
            previousAudioBytes,
            Boolean(audio),
            this.logger
          ).catch(() => {}),
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
    for (let i = 0; i < rows.length; i++) {
      await tx.content.update({ where: { id: rows[i]!.id }, data: { sortOrder: -(i + 1) } });
    }
    for (let i = 0; i < rows.length; i++) {
      await tx.content.update({ where: { id: rows[i]!.id }, data: { sortOrder: i } });
    }
  }

  private async requireContent(contentId: string): Promise<{
    id: string;
    groupId: string;
    sortOrder: number;
    kind: ContentKind;
    imageEtag: string;
    audioEtag: string | null;
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
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    return content;
  }

  private toMutationResponse(
    contentId: string,
    seq: number,
    imageEtag: string,
    audioEtag: string | null,
    groupEtag: string
  ): ContentMutationResponseT {
    return {
      id: contentId,
      seq,
      image_etag: imageEtag,
      audio_etag: audioEtag,
      group_etag: groupEtag,
    };
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

function deviceStatusBarText(row: StatusBarTextSource): string {
  if (row.kind !== 'dynamic') return row.frameName ?? '';
  switch (row.dynamicType) {
    case 'daily_calendar':
      return dailyCalendarStatusBarText(row.dynamicData, row.dynamicConfig);
    case 'month_calendar':
      return monthCalendarStatusBarText(row.dynamicConfig);
    case 'history_today':
      return historyTodayStatusBarText(row.dynamicData, row.dynamicConfig);
    case 'weather':
      return weatherStatusBarText(row.dynamicConfig);
    case 'dashboard':
      return row.frameName ?? '数据看板';
    case 'font_test':
      return fontTestStatusBarText(row.dynamicConfig);
    default:
      return row.frameName ?? '';
  }
}

function dailyCalendarStatusBarText(
  data: Prisma.JsonValue | null | undefined,
  config: Prisma.JsonValue | null | undefined
): string {
  const parts = datePartsInTz(new Date(), timezoneFromConfig(config));
  const month = valueText(recordValue(data, 'month')) ?? String(parts.month);
  const day = valueText(recordValue(data, 'day')) ?? String(parts.day);
  return `${Number(month)}月${Number(day)}日`;
}

function monthCalendarStatusBarText(config: Prisma.JsonValue | null | undefined): string {
  const parts = datePartsInTz(new Date(), timezoneFromConfig(config));
  return `${parts.year}年${parts.month}月`;
}

function historyTodayStatusBarText(
  data: Prisma.JsonValue | null | undefined,
  config: Prisma.JsonValue | null | undefined
): string {
  const label =
    valueText(recordValue(data, 'dateLabel')) ?? cnMonthDay(new Date(), timezoneFromConfig(config));
  return `历史上的${label.replace(/\s+/g, '')}`;
}

function weatherStatusBarText(config: unknown): string {
  const location = valueText(recordValue(config, 'location_label')) ?? '天气';
  return location === '天气' ? '天气' : `${location}天气`;
}

function fontTestStatusBarText(config: unknown): string {
  const id = valueText(recordValue(config, 'font_id'));
  return id ? (FONT_TEST_FONTS.find((font) => font.id === id)?.label ?? '字体测试') : '字体测试';
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

function cnMonthDay(date: Date, timeZone: string): string {
  const parts = datePartsInTz(date, timeZone);
  return `${parts.month}月${parts.day}日`;
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
