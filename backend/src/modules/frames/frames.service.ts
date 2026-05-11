import { createId } from '@paralleldrive/cuid2';
import { Injectable, Logger } from '@nestjs/common';
import type { FrameMutationResponseT, FrameSummaryT, ManifestResponseT } from 'shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { BlobService } from '../../infra/blob/blob.service';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import { computeETag } from '../../common/etag/etag.util';
import { GroupsService } from '../groups/groups.service';
import { RenderService } from '../render/render.service';
import { AudioService } from '../audio/audio.service';
import type { ParsedFrameUpload } from './multipart.parser';

interface FrameRow {
  sortOrder: number;
  caption: string | null;
  imageEtag: string;
  audioEtag: string | null;
  imageSize: number;
  audioSize: number | null;
}

function frameToSummary(f: FrameRow): FrameSummaryT {
  return {
    sort_order: f.sortOrder,
    caption: f.caption,
    image_etag: f.imageEtag,
    audio_etag: f.audioEtag,
    image_size: f.imageSize,
    audio_size: f.audioSize,
  };
}

const FRAME_SELECT = {
  sortOrder: true,
  caption: true,
  imageEtag: true,
  audioEtag: true,
  imageSize: true,
  audioSize: true,
} as const;

@Injectable()
export class FramesService {
  private readonly logger = new Logger(FramesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly groups: GroupsService,
    private readonly render: RenderService,
    private readonly audio: AudioService
  ) {}

  // ── 读 ────────────────────────────────────────────────────

  async assertReadable(gid: string, scope: { userId?: string; deviceId?: string }): Promise<void> {
    const g = await this.prisma.group.findUnique({
      where: { id: gid },
      select: { ownerUserId: true },
    });
    if (!g) throw new NotFoundError('group not found');
    if (scope.userId !== undefined && g.ownerUserId !== scope.userId) {
      throw new NotFoundError('group not found');
    }
    // device 不做 group owner 比对（内网信任模型）
  }

  async manifest(
    gid: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<ManifestResponseT & { etag: string }> {
    await this.assertReadable(gid, scope);
    const group = await this.prisma.group.findUnique({
      where: { id: gid },
      include: {
        frames: {
          orderBy: { sortOrder: 'asc' },
          select: FRAME_SELECT,
        },
      },
    });
    if (!group) throw new NotFoundError('group not found');
    return {
      group_id: group.id,
      group_etag: group.etag,
      frames: group.frames.map(frameToSummary),
      default_frame_seq: 0,
      etag: group.etag,
    };
  }

  async listFrames(
    gid: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<FrameSummaryT[]> {
    await this.assertReadable(gid, scope);
    const frames = await this.prisma.frame.findMany({
      where: { groupId: gid },
      orderBy: { sortOrder: 'asc' },
      select: FRAME_SELECT,
    });
    return frames.map(frameToSummary);
  }

  async getFrame(
    gid: string,
    seq: number,
    scope: { userId?: string; deviceId?: string }
  ): Promise<FrameSummaryT> {
    await this.assertReadable(gid, scope);
    const f = await this.prisma.frame.findUnique({
      where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
      select: FRAME_SELECT,
    });
    if (!f) throw new NotFoundError('frame not found');
    return frameToSummary(f);
  }

  async readFrameImage(
    gid: string,
    seq: number,
    scope: { userId?: string; deviceId?: string }
  ): Promise<{ data: Buffer; etag: string }> {
    await this.assertReadable(gid, scope);
    const f = await this.prisma.frame.findUnique({
      where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
      select: { id: true, imageEtag: true },
    });
    if (!f) throw new NotFoundError('frame not found');
    const buf = await this.blob.read(gid, f.id, 'image');
    if (!buf) throw new NotFoundError('image blob missing');
    return { data: buf, etag: f.imageEtag };
  }

  async readFrameAudio(
    gid: string,
    seq: number,
    scope: { userId?: string; deviceId?: string }
  ): Promise<{ data: Buffer; etag: string }> {
    await this.assertReadable(gid, scope);
    const f = await this.prisma.frame.findUnique({
      where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
      select: { id: true, audioEtag: true, audioSize: true },
    });
    if (!f || !f.audioEtag || !f.audioSize) {
      throw new NotFoundError('audio not available');
    }
    const buf = await this.blob.read(gid, f.id, 'audio');
    if (!buf) throw new NotFoundError('audio blob missing');
    return { data: buf, etag: f.audioEtag };
  }

  // ── 写 ────────────────────────────────────────────────────

  async appendFrame(
    gid: string,
    ownerUserId: string,
    parsed: ParsedFrameUpload
  ): Promise<FrameMutationResponseT> {
    await this.groups.assertOwned(gid, ownerUserId);
    if (!parsed.hasImage) {
      throw new ValidationError('image required', { code: 'image_required' });
    }
    const last = await this.prisma.frame.findFirst({
      where: { groupId: gid },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const seq = last ? last.sortOrder + 1 : 0;
    return this.createFrameUpload(gid, seq, parsed);
  }

  async patchFrameMultipart(
    gid: string,
    seq: number,
    ownerUserId: string,
    parsed: ParsedFrameUpload
  ): Promise<FrameMutationResponseT> {
    await this.groups.assertOwned(gid, ownerUserId);
    const { id: frameId } = await this.requireFrame(gid, seq);
    return this.updateFrameUpload(gid, seq, frameId, parsed);
  }

  async patchFrameCaption(
    gid: string,
    seq: number,
    ownerUserId: string,
    caption: string | null | undefined
  ): Promise<FrameMutationResponseT> {
    await this.groups.assertOwned(gid, ownerUserId);
    await this.requireFrame(gid, seq);
    if (caption === undefined) {
      throw new ValidationError('nothing to patch', { code: 'nothing_to_patch' });
    }
    await this.prisma.frame.update({
      where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
      data: { caption },
    });
    const newEtag = await this.groups.recomputeGroupEtag(gid);
    const cur = await this.prisma.frame.findUnique({
      where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
      select: { imageEtag: true, audioEtag: true },
    });
    return {
      sort_order: seq,
      image_etag: cur?.imageEtag ?? '',
      audio_etag: cur?.audioEtag ?? null,
      group_etag: newEtag,
    };
  }

  async deleteFrame(gid: string, seq: number, ownerUserId: string): Promise<void> {
    await this.groups.assertOwned(gid, ownerUserId);
    const { id: frameId } = await this.requireFrame(gid, seq);
    // 先删库再删盘：DB 删除失败时 blob 仍在，记录保持一致；
    // blob 删除失败时仅留孤儿文件，不影响数据正确性。
    await this.prisma.frame.delete({ where: { id: frameId } });
    await Promise.all([
      this.blob.delete(gid, frameId, 'image'),
      this.blob.delete(gid, frameId, 'audio'),
    ]);
    await this.groups.recomputeGroupEtag(gid);
  }

  async deleteAudio(
    gid: string,
    seq: number,
    ownerUserId: string
  ): Promise<{ group_etag: string }> {
    await this.groups.assertOwned(gid, ownerUserId);
    const { id: frameId } = await this.requireFrame(gid, seq);
    await this.blob.delete(gid, frameId, 'audio');
    await this.prisma.frame.update({
      where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
      data: { audioEtag: null, audioSize: null },
    });
    const group_etag = await this.groups.recomputeGroupEtag(gid);
    return { group_etag };
  }

  async reorderFrames(
    gid: string,
    ownerUserId: string,
    order: number[]
  ): Promise<{ group_etag: string }> {
    await this.groups.assertOwned(gid, ownerUserId);
    const all = await this.prisma.frame.findMany({
      where: { groupId: gid },
      select: { sortOrder: true },
    });
    const allSeq = new Set(all.map((f) => f.sortOrder));
    const orderSet = new Set(order);
    if (
      order.length !== allSeq.size ||
      orderSet.size !== order.length ||
      !order.every((s) => allSeq.has(s))
    ) {
      throw new ValidationError('order must list every existing sort_order exactly once', {
        code: 'order_mismatch',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < order.length; i++) {
        await tx.frame.update({
          where: { groupId_sortOrder: { groupId: gid, sortOrder: order[i]! } },
          data: { sortOrder: -(i + 1) },
        });
      }
      for (let i = 0; i < order.length; i++) {
        await tx.frame.update({
          where: { groupId_sortOrder: { groupId: gid, sortOrder: -(i + 1) } },
          data: { sortOrder: i },
        });
      }
    });
    const group_etag = await this.groups.recomputeGroupEtag(gid);
    return { group_etag };
  }

  // ── 内部：完整 image/audio + caption 写入 + recompute etag ──

  /** 渲染上传中的 image/audio。无对应字段时返回 null。 */
  private async renderUpload(parsed: ParsedFrameUpload): Promise<{
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
      const bytes = await this.audio.transcodeAudio(parsed.audioBuf, 'upload');
      audio = { bytes, etag: computeETag(bytes), size: bytes.byteLength };
    }

    return { image, audio };
  }

  /** 新建：先盘后库，db.create 失败回滚 blob。 */
  private async createFrameUpload(
    gid: string,
    seq: number,
    parsed: ParsedFrameUpload
  ): Promise<FrameMutationResponseT> {
    const { image, audio } = await this.renderUpload(parsed);
    if (!image) throw new ValidationError('image required for create');

    const newId = createId();
    try {
      await this.blob.write(gid, newId, 'image', image.bytes);
      if (audio) await this.blob.write(gid, newId, 'audio', audio.bytes);
      await this.prisma.frame.create({
        data: {
          id: newId,
          groupId: gid,
          sortOrder: seq,
          caption: parsed.hasCaption ? parsed.caption : null,
          imageEtag: image.etag,
          imageSize: image.size,
          audioEtag: audio?.etag ?? null,
          audioSize: audio?.size ?? null,
        },
      });
    } catch (err) {
      await Promise.all([
        this.blob.delete(gid, newId, 'image').catch(() => {}),
        this.blob.delete(gid, newId, 'audio').catch(() => {}),
      ]);
      const code = (err as { code?: string }).code;
      if (code === 'P2002') throw new ConflictError('frame sortOrder already exists');
      throw err;
    }

    const group_etag = await this.groups.recomputeGroupEtag(gid);
    return {
      sort_order: seq,
      image_etag: image.etag,
      audio_etag: audio?.etag ?? null,
      group_etag,
    };
  }

  /** 更新：blob 覆盖写 + db.update。仅当 caption/image/audio 有变化时落库。 */
  private async updateFrameUpload(
    gid: string,
    seq: number,
    frameId: string,
    parsed: ParsedFrameUpload
  ): Promise<FrameMutationResponseT> {
    const { image, audio } = await this.renderUpload(parsed);

    if (image) await this.blob.write(gid, frameId, 'image', image.bytes);
    if (audio) await this.blob.write(gid, frameId, 'audio', audio.bytes);

    // ⚠ blob 已覆盖写：若 db.update 失败，blob 是新内容但 etag 未更新，
    // 重试时会重新写入并更新 etag，属于可自愈的短暂不一致。
    const data: Record<string, unknown> = {};
    if (parsed.hasCaption) data.caption = parsed.caption;
    if (image) {
      data.imageEtag = image.etag;
      data.imageSize = image.size;
    }
    if (audio) {
      data.audioEtag = audio.etag;
      data.audioSize = audio.size;
    }
    if (Object.keys(data).length > 0) {
      try {
        await this.prisma.frame.update({
          where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
          data,
        });
      } catch (err) {
        this.logger.error(
          `updateFrameUpload: blob written but db update failed — gid=${gid} seq=${seq}`,
          err
        );
        throw err;
      }
    }

    const group_etag = await this.groups.recomputeGroupEtag(gid);

    // 未上传的字段读 db 当前值（前端依赖响应里的 etag 做缓存键）
    let finalImageEtag = image?.etag ?? null;
    let finalAudioEtag = audio?.etag ?? null;
    if (!finalImageEtag || !finalAudioEtag) {
      const cur = await this.prisma.frame.findUnique({
        where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
        select: { imageEtag: true, audioEtag: true },
      });
      if (cur) {
        finalImageEtag ??= cur.imageEtag;
        finalAudioEtag ??= cur.audioEtag;
      }
    }
    if (!finalImageEtag) {
      throw new Error(`imageEtag missing for frame gid=${gid} seq=${seq} after update`);
    }
    return {
      sort_order: seq,
      image_etag: finalImageEtag,
      audio_etag: finalAudioEtag,
      group_etag,
    };
  }

  private async requireFrame(gid: string, seq: number): Promise<{ id: string }> {
    const f = await this.prisma.frame.findUnique({
      where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
      select: { id: true },
    });
    if (!f) throw new NotFoundError('frame not found');
    return f;
  }
}
