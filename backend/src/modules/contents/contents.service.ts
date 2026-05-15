import { createId } from '@paralleldrive/cuid2';
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  CreateDynamicContentRequest,
  DynamicConfig,
  type ContentDetailT,
  type ContentMutationResponseT,
  type ContentSummaryT,
  type CreateDynamicContentRequestT,
  type DynamicConfigResponseT,
  type ManifestResponseT,
} from 'shared';
import { BlobService, type BlobKind } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { computeETag } from '../../common/etag/etag.util';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import { AudioService } from '../audio/audio.service';
import { GroupsService } from '../groups/groups.service';
import { RenderService } from '../render/render.service';
import { WidgetRegistry } from '../widgets/widget-registry';
import { DynamicContentRendererService } from '../widgets/dynamic-content-renderer.service';
import type { ParsedContentUpload } from './multipart.parser';

interface ContentRow {
  id: string;
  sortOrder: number;
  caption: string | null;
  imageEtag: string;
  audioEtag: string | null;
  imageSize: number;
  audioSize: number | null;
  kind: 'image' | 'dynamic';
  dynamicType: string | null;
}

const CONTENT_SELECT = {
  id: true,
  sortOrder: true,
  caption: true,
  imageEtag: true,
  audioEtag: true,
  imageSize: true,
  audioSize: true,
  kind: true,
  dynamicType: true,
} as const;

export const MAX_DYNAMIC_CONTENTS_PER_GROUP = 10;

function nextWakeSec(nextRunAt: Date | null): number | null {
  if (!nextRunAt) return null;
  return Math.max(Math.ceil((nextRunAt.getTime() - Date.now()) / 1000), 0);
}

function toMutationResponse(
  contentId: string,
  seq: number,
  imageEtag: string,
  audioEtag: string | null,
  groupEtag: string
): ContentMutationResponseT {
  return {
    content_id: contentId,
    seq,
    image_etag: imageEtag,
    audio_etag: audioEtag,
    group_etag: groupEtag,
  };
}

@Injectable()
export class ContentsService {
  private readonly logger = new Logger(ContentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly groups: GroupsService,
    private readonly render: RenderService,
    private readonly audio: AudioService,
    @Inject(forwardRef(() => DynamicContentRendererService))
    private readonly dynamicRenderer: DynamicContentRendererService,
    private readonly widgetRegistry: WidgetRegistry
  ) {}

  async assertReadable(gid: string, scope: { userId?: string; deviceId?: string }): Promise<void> {
    const group = await this.prisma.group.findUnique({
      where: { id: gid },
      select: { ownerUserId: true },
    });
    if (!group) throw new NotFoundError('相册不存在');
    if (scope.userId !== undefined && group.ownerUserId !== scope.userId) {
      throw new NotFoundError('相册不存在');
    }
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
          select: { ...CONTENT_SELECT, dynamicNextRunAt: true },
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
        groupId: true,
        dynamicConfig: true,
        dynamicData: true,
        dynamicLastRunAt: true,
        dynamicNextRunAt: true,
        dynamicLastError: true,
      },
    });
    return rows.map((row) => ({
      ...this.toSummary(row),
      group_id: row.groupId,
      dynamic_config: row.dynamicConfig as unknown,
      dynamic_data: row.dynamicData as unknown,
      dynamic_last_rendered_at: row.dynamicLastRunAt?.toISOString() ?? null,
      dynamic_next_render_at: row.dynamicNextRunAt?.toISOString() ?? null,
      dynamic_render_error: row.dynamicLastError,
    }));
  }

  async get(
    contentId: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<ContentSummaryT> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { ...CONTENT_SELECT, groupId: true, dynamicNextRunAt: true },
    });
    if (!content) throw new NotFoundError('内容不存在');
    await this.assertReadable(content.groupId, scope);
    return this.toSummary(content);
  }

  async getDynamicConfig(contentId: string, ownerUserId: string): Promise<DynamicConfigResponseT> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        kind: true,
        dynamicType: true,
        dynamicConfig: true,
        caption: true,
        groupId: true,
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic' || !content.dynamicType) {
      throw new ValidationError('该内容不是动态类型');
    }
    await this.groups.assertOwned(content.groupId, ownerUserId);
    const config = DynamicConfig.parse(content.dynamicConfig);
    return {
      dynamic_type: config.type,
      config,
      title: content.caption,
    };
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
    if (!content.audioEtag || !content.audioSize) {
      throw new NotFoundError('该内容没有音频');
    }
    const data = await this.blob.read(content.groupId, content.id, 'audio');
    if (!data) throw new NotFoundError('音频文件丢失');
    return { data, etag: content.audioEtag };
  }

  async appendImage(
    gid: string,
    ownerUserId: string,
    parsed: ParsedContentUpload
  ): Promise<ContentMutationResponseT> {
    await this.groups.assertOwned(gid, ownerUserId);
    if (!parsed.hasImage) throw new ValidationError('请上传图片', { code: 'image_required' });
    const seq = await this.nextSortOrder(gid);
    return this.createImage(gid, seq, parsed);
  }

  async appendDynamic(
    gid: string,
    ownerUserId: string,
    raw: CreateDynamicContentRequestT
  ): Promise<ContentMutationResponseT> {
    await this.groups.assertOwned(gid, ownerUserId);
    const top = CreateDynamicContentRequest.safeParse(raw);
    if (!top.success) throw new ValidationError(`请求体非法: ${top.error.message}`);

    const { dynamic_type, config, title } = top.data;
    const entry = this.widgetRegistry.get(dynamic_type);
    if (!entry) throw new ValidationError(`未知动态类型: ${dynamic_type}`);

    const validatedConfig = DynamicConfig.parse(config);
    if (validatedConfig.type !== dynamic_type) {
      throw new ValidationError(
        `dynamic_type 与 config.type 不一致: ${dynamic_type} vs ${validatedConfig.type}`
      );
    }

    const dynamicCount = await this.prisma.content.count({
      where: { groupId: gid, kind: 'dynamic' },
    });
    if (dynamicCount >= MAX_DYNAMIC_CONTENTS_PER_GROUP) {
      throw new ValidationError(
        `该相册动态内容数已达上限 ${MAX_DYNAMIC_CONTENTS_PER_GROUP}，请先删除一些`,
        {
          code: 'dynamic_limit',
        }
      );
    }

    const seq = await this.nextSortOrder(gid);
    const contentId = createId();
    const placeholderEtag = computeETag(`dynamic-init:${contentId}`);
    try {
      await this.prisma.content.create({
        data: {
          id: contentId,
          groupId: gid,
          sortOrder: seq,
          caption: title ?? null,
          imageEtag: placeholderEtag,
          imageSize: 0,
          kind: 'dynamic',
          dynamicType: dynamic_type,
          dynamicConfig: validatedConfig as unknown as Prisma.InputJsonValue,
          dynamicNextRunAt: new Date(0),
        },
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') throw new ConflictError('内容序号已存在');
      throw err;
    }

    try {
      const rendered = await this.dynamicRenderer.renderDynamicContent(contentId, { force: true });
      return toMutationResponse(contentId, seq, rendered.imageEtag, null, rendered.groupEtag);
    } catch (err) {
      this.logger.warn(
        `首次渲染动态内容失败，回滚 ${contentId}: ${err instanceof Error ? err.message : String(err)}`
      );
      await this.blob.delete(gid, contentId, 'image').catch((rollbackErr) => {
        this.logger.warn(
          `首次渲染失败后的 image blob 回滚失败 contentId=${contentId}: ${formatError(rollbackErr)}`
        );
      });
      await this.prisma.content.delete({ where: { id: contentId } }).catch((rollbackErr) => {
        this.logger.warn(
          `首次渲染失败后的 DB 回滚失败 contentId=${contentId}: ${formatError(rollbackErr)}`
        );
      });
      await this.groups.recomputeGroupEtag(gid).catch((rollbackErr) => {
        this.logger.warn(
          `首次渲染失败后的 group etag 回滚失败 gid=${gid}: ${formatError(rollbackErr)}`
        );
      });
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
    if (content.kind !== 'image' && parsed.hasImage) {
      throw new ValidationError('动态内容的画面由服务端生成，不能上传图片替换');
    }
    return this.updateImage(content.groupId, content.sortOrder, contentId, parsed);
  }

  async patchDynamic(
    contentId: string,
    ownerUserId: string,
    body: { title?: string | null; config?: unknown }
  ): Promise<ContentMutationResponseT> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { id: true, groupId: true, sortOrder: true, kind: true, dynamicType: true },
    });
    if (!content) throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic') throw new ValidationError('该内容不是动态类型');
    await this.groups.assertOwned(content.groupId, ownerUserId);

    const data: Prisma.ContentUpdateInput = {};
    if (body.title !== undefined) data.caption = body.title;
    if (body.config !== undefined) {
      const validated = DynamicConfig.parse(body.config);
      if (validated.type !== content.dynamicType) {
        throw new ValidationError(
          `不能在已有动态内容上改 type（${content.dynamicType} → ${validated.type}），请删除后重建`
        );
      }
      data.dynamicConfig = validated as unknown as Prisma.InputJsonValue;
    }
    if (Object.keys(data).length === 0) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }

    await this.prisma.content.update({ where: { id: contentId }, data });
    const rendered = await this.dynamicRenderer.renderDynamicContent(contentId, { force: true });
    const latest = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { audioEtag: true },
    });
    return toMutationResponse(
      contentId,
      content.sortOrder,
      rendered.imageEtag,
      latest?.audioEtag ?? null,
      rendered.groupEtag
    );
  }

  async patchTitle(
    contentId: string,
    ownerUserId: string,
    title: string | null | undefined
  ): Promise<ContentMutationResponseT> {
    const content = await this.requireContent(contentId);
    await this.groups.assertOwned(content.groupId, ownerUserId);
    if (title === undefined) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }
    await this.prisma.content.update({
      where: { id: contentId },
      data: { caption: title },
    });
    const groupEtag = await this.groups.recomputeGroupEtag(content.groupId);
    const latest = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { imageEtag: true, audioEtag: true },
    });
    return toMutationResponse(
      contentId,
      content.sortOrder,
      latest?.imageEtag ?? '',
      latest?.audioEtag ?? null,
      groupEtag
    );
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
      await this.prisma.content.delete({ where: { id: contentId } });
    } catch (err) {
      this.logger.error(`delete: blob deleted but db delete failed contentId=${contentId}`, err);
      await Promise.all([
        this.restoreBlob(content.groupId, contentId, 'image', previousImage, 'delete DB 失败'),
        this.restoreBlob(content.groupId, contentId, 'audio', previousAudio, 'delete DB 失败'),
      ]);
      throw err;
    }
    await this.groups.recomputeGroupEtag(content.groupId);
  }

  async deleteAudio(contentId: string, ownerUserId: string): Promise<{ group_etag: string }> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { id: true, groupId: true, audioEtag: true, audioSize: true },
    });
    if (!content) throw new NotFoundError('内容不存在');
    await this.groups.assertOwned(content.groupId, ownerUserId);
    const previousAudio = await this.blob.read(content.groupId, contentId, 'audio');
    await this.prisma.content.update({
      where: { id: contentId },
      data: { audioEtag: null, audioSize: null },
    });
    try {
      await this.blob.delete(content.groupId, contentId, 'audio');
    } catch (err) {
      this.logger.error(
        `deleteAudio: db updated but blob delete failed contentId=${contentId}`,
        err
      );
      await this.prisma.content
        .update({
          where: { id: contentId },
          data: { audioEtag: content.audioEtag, audioSize: content.audioSize },
        })
        .catch((rollbackErr) => {
          this.logger.warn(
            `deleteAudio 失败后的 DB 回滚失败 contentId=${contentId}: ${formatError(rollbackErr)}`
          );
        });
      await this.restoreBlob(content.groupId, contentId, 'audio', previousAudio, 'deleteAudio');
      throw err;
    }
    const group_etag = await this.groups.recomputeGroupEtag(content.groupId);
    return { group_etag };
  }

  async reorder(
    gid: string,
    ownerUserId: string,
    order: string[]
  ): Promise<{ group_etag: string }> {
    await this.groups.assertOwned(gid, ownerUserId);
    const all = await this.prisma.content.findMany({
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

    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < order.length; i++) {
        await tx.content.update({ where: { id: order[i]! }, data: { sortOrder: -(i + 1) } });
      }
      for (let i = 0; i < order.length; i++) {
        await tx.content.update({ where: { id: order[i]! }, data: { sortOrder: i } });
      }
    });
    const group_etag = await this.groups.recomputeGroupEtag(gid);
    return { group_etag };
  }

  private toSummary(row: ContentRow & { dynamicNextRunAt?: Date | null }): ContentSummaryT {
    return {
      content_id: row.id,
      seq: row.sortOrder,
      title: row.caption,
      image_etag: row.imageEtag,
      audio_etag: row.audioEtag,
      image_size: row.imageSize,
      audio_size: row.audioSize,
      kind: row.kind === 'dynamic' ? 'dynamic' : 'image',
      dynamic_type: row.dynamicType,
      next_wake_sec:
        row.kind === 'dynamic'
          ? (nextWakeSec(row.dynamicNextRunAt ?? null) ??
            (row.dynamicType ? this.widgetRegistry.defaultTtlSec(row.dynamicType) : null))
          : null,
    };
  }

  private async renderUpload(parsed: ParsedContentUpload): Promise<{
    image: { bytes: Buffer; etag: string; size: number } | null;
    audio: { bytes: Buffer; etag: string; size: number } | null;
  }> {
    let image: { bytes: Buffer; etag: string; size: number } | null = null;
    if (parsed.hasImage && parsed.imageBuf) {
      const rendered = await this.render.renderTo1bpp(parsed.imageBuf, {
        threshold: parsed.threshold,
        mode: parsed.mode,
      });
      this.render.validateFrameSize(rendered.data);
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

  private async createImage(
    gid: string,
    seq: number,
    parsed: ParsedContentUpload
  ): Promise<ContentMutationResponseT> {
    const { image, audio } = await this.renderUpload(parsed);
    if (!image) throw new ValidationError('创建图片内容时必须上传图片');

    const contentId = createId();
    try {
      await this.blob.write(gid, contentId, 'image', image.bytes);
      if (audio) await this.blob.write(gid, contentId, 'audio', audio.bytes);
      await this.prisma.content.create({
        data: {
          id: contentId,
          groupId: gid,
          sortOrder: seq,
          caption: parsed.hasTitle ? parsed.title : null,
          imageEtag: image.etag,
          imageSize: image.size,
          audioEtag: audio?.etag ?? null,
          audioSize: audio?.size ?? null,
        },
      });
    } catch (err) {
      await Promise.all([
        this.blob.delete(gid, contentId, 'image').catch((rollbackErr) => {
          this.logger.warn(
            `创建图片内容失败后的 image blob 回滚失败 contentId=${contentId}: ${formatError(rollbackErr)}`
          );
        }),
        this.blob.delete(gid, contentId, 'audio').catch((rollbackErr) => {
          this.logger.warn(
            `创建图片内容失败后的 audio blob 回滚失败 contentId=${contentId}: ${formatError(rollbackErr)}`
          );
        }),
      ]);
      const code = (err as { code?: string }).code;
      if (code === 'P2002') throw new ConflictError('内容序号已存在');
      throw err;
    }

    const groupEtag = await this.groups.recomputeGroupEtag(gid);
    return toMutationResponse(contentId, seq, image.etag, audio?.etag ?? null, groupEtag);
  }

  private async updateImage(
    gid: string,
    seq: number,
    contentId: string,
    parsed: ParsedContentUpload
  ): Promise<ContentMutationResponseT> {
    const { image, audio } = await this.renderUpload(parsed);
    const data: Prisma.ContentUpdateInput = {};
    if (parsed.hasTitle) data.caption = parsed.title;
    if (image) {
      data.imageEtag = image.etag;
      data.imageSize = image.size;
    }
    if (audio) {
      data.audioEtag = audio.etag;
      data.audioSize = audio.size;
    }

    const previousImage = image ? await this.blob.read(gid, contentId, 'image') : null;
    const previousAudio = audio ? await this.blob.read(gid, contentId, 'audio') : null;
    let wroteImage = false;
    let wroteAudio = false;
    if (Object.keys(data).length > 0) {
      try {
        if (image) {
          await this.blob.write(gid, contentId, 'image', image.bytes);
          wroteImage = true;
        }
        if (audio) {
          await this.blob.write(gid, contentId, 'audio', audio.bytes);
          wroteAudio = true;
        }
        await this.prisma.content.update({
          where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
          data,
        });
      } catch (err) {
        this.logger.error(
          `updateImage: blob written but db update failed gid=${gid} seq=${seq}`,
          err
        );
        await Promise.all([
          wroteImage
            ? this.restoreBlobAfterFailedUpdate(gid, contentId, 'image', previousImage)
            : Promise.resolve(),
          wroteAudio
            ? this.restoreBlobAfterFailedUpdate(gid, contentId, 'audio', previousAudio)
            : Promise.resolve(),
        ]);
        throw err;
      }
    }

    const groupEtag = await this.groups.recomputeGroupEtag(gid);
    let finalImageEtag = image?.etag ?? null;
    let finalAudioEtag = audio?.etag ?? null;
    if (!finalImageEtag || !finalAudioEtag) {
      const latest = await this.prisma.content.findUnique({
        where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
        select: { imageEtag: true, audioEtag: true },
      });
      finalImageEtag ??= latest?.imageEtag ?? null;
      finalAudioEtag ??= latest?.audioEtag ?? null;
    }
    if (!finalImageEtag) {
      throw new Error(`imageEtag missing for content gid=${gid} seq=${seq} after update`);
    }
    return toMutationResponse(contentId, seq, finalImageEtag, finalAudioEtag, groupEtag);
  }

  private async nextSortOrder(gid: string): Promise<number> {
    const last = await this.prisma.content.findFirst({
      where: { groupId: gid },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return last ? last.sortOrder + 1 : 0;
  }

  private async requireContent(
    contentId: string
  ): Promise<{ id: string; groupId: string; sortOrder: number; kind: 'image' | 'dynamic' }> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { id: true, groupId: true, sortOrder: true, kind: true },
    });
    if (!content) throw new NotFoundError('内容不存在');
    return content;
  }

  private async restoreBlobAfterFailedUpdate(
    gid: string,
    contentId: string,
    kind: BlobKind,
    previous: Buffer | null
  ): Promise<void> {
    await this.restoreBlob(gid, contentId, kind, previous, 'updateImage DB 失败');
  }

  private async restoreBlob(
    gid: string,
    contentId: string,
    kind: BlobKind,
    previous: Buffer | null,
    context: string
  ): Promise<void> {
    try {
      if (previous) {
        await this.blob.write(gid, contentId, kind, previous);
      } else {
        await this.blob.delete(gid, contentId, kind);
      }
    } catch (rollbackErr) {
      this.logger.warn(
        `${context} 后的 ${kind} blob 回滚失败 contentId=${contentId}: ${formatError(rollbackErr)}`
      );
    }
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
