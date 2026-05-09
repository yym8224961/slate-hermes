import { Injectable, Logger } from '@nestjs/common';
import type {
  FrameMutationResponseT,
  FrameSummaryT,
  ManifestResponseT,
  RenderFrameRequestT,
} from 'shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { BlobService } from '../../infra/blob/blob.service';
import {
  ConflictError,
  NotFoundError,
  NotImplementedError,
  ValidationError,
} from '../../common/errors';
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
          select: {
            sortOrder: true,
            caption: true,
            imageEtag: true,
            audioEtag: true,
            imageSize: true,
            audioSize: true,
          },
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
      select: {
        sortOrder: true,
        caption: true,
        imageEtag: true,
        audioEtag: true,
        imageSize: true,
        audioSize: true,
      },
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
      select: {
        sortOrder: true,
        caption: true,
        imageEtag: true,
        audioEtag: true,
        imageSize: true,
        audioSize: true,
      },
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
      select: { imageEtag: true },
    });
    if (!f) throw new NotFoundError('frame not found');
    const buf = await this.blob.read(gid, seq, 'image');
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
      select: { audioEtag: true, audioSize: true },
    });
    if (!f || !f.audioEtag || !f.audioSize) {
      throw new NotFoundError('audio not available');
    }
    const buf = await this.blob.read(gid, seq, 'audio');
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
    return this.persistFrame(gid, seq, parsed, 'create');
  }

  async patchFrameMultipart(
    gid: string,
    seq: number,
    ownerUserId: string,
    parsed: ParsedFrameUpload
  ): Promise<FrameMutationResponseT> {
    await this.groups.assertOwned(gid, ownerUserId);
    await this.requireFrame(gid, seq);
    return this.persistFrame(gid, seq, parsed, 'update');
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
    await this.requireFrame(gid, seq);
    await this.blob.delete(gid, seq, 'image');
    await this.blob.delete(gid, seq, 'audio');
    await this.prisma.frame.deleteMany({ where: { groupId: gid, sortOrder: seq } });
    await this.groups.recomputeGroupEtag(gid);
  }

  async deleteAudio(
    gid: string,
    seq: number,
    ownerUserId: string
  ): Promise<{ group_etag: string }> {
    await this.groups.assertOwned(gid, ownerUserId);
    await this.requireFrame(gid, seq);
    await this.blob.delete(gid, seq, 'audio');
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

  /** 外部/Web 推预渲内容到指定帧（dynamic group）。 */
  async renderToFrame(
    gid: string,
    seq: number,
    body: RenderFrameRequestT
  ): Promise<FrameMutationResponseT> {
    const group = await this.prisma.group.findUnique({
      where: { id: gid },
      select: { id: true, kind: true },
    });
    if (!group) throw new NotFoundError('group not found');
    if (group.kind !== 'dynamic') {
      throw new ValidationError('group must be dynamic', { code: 'group_kind_mismatch' });
    }

    let imageBuf: Buffer;
    if (body.source === 'png_base64') {
      try {
        imageBuf = Buffer.from(body.content, 'base64');
      } catch {
        throw new ValidationError('invalid base64', { code: 'invalid_base64' });
      }
    } else {
      throw new NotImplementedError(`source=${body.source} not yet supported`);
    }

    const rendered = await this.render.renderTo1bpp(imageBuf, {
      threshold: body.threshold,
      mode: body.mode,
    });
    this.render.validateFrameSize(rendered.data);

    const imageEtag = computeETag(rendered.data);
    await this.blob.write(gid, seq, 'image', rendered.data);
    await this.prisma.frame.upsert({
      where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
      create: {
        groupId: gid,
        sortOrder: seq,
        imageEtag,
        imageSize: rendered.data.byteLength,
      },
      update: {
        imageEtag,
        imageSize: rendered.data.byteLength,
      },
    });
    const group_etag = await this.groups.recomputeGroupEtag(gid);
    this.logger.log(`frame rendered: gid=${gid} seq=${seq} src=${body.source}`);
    return {
      sort_order: seq,
      image_etag: imageEtag,
      audio_etag: null,
      group_etag,
    };
  }

  // ── 内部：完整 image/audio + caption 写入 + recompute etag ──

  private async persistFrame(
    gid: string,
    seq: number,
    parsed: ParsedFrameUpload,
    mode: 'create' | 'update'
  ): Promise<FrameMutationResponseT> {
    let imageEtag: string | null = null;
    let imageSize: number | null = null;
    let imageBytes: Buffer | null = null;
    if (parsed.hasImage && parsed.imageBuf) {
      const rendered = await this.render.renderTo1bpp(parsed.imageBuf, {
        threshold: parsed.threshold,
        mode: parsed.mode,
      });
      this.render.validateFrameSize(rendered.data);
      imageBytes = rendered.data;
      imageEtag = computeETag(rendered.data);
      imageSize = rendered.data.byteLength;
    }

    let audioEtag: string | null = null;
    let audioSize: number | null = null;
    let audioBytes: Buffer | null = null;
    if (parsed.hasAudio && parsed.audioBuf) {
      audioBytes = await this.audio.transcodeAudio(parsed.audioBuf, 'upload');
      audioEtag = computeETag(audioBytes);
      audioSize = audioBytes.byteLength;
    }

    if (mode === 'create') {
      if (!imageEtag || imageSize === null) {
        throw new ValidationError('image required for create');
      }
      try {
        await this.prisma.frame.create({
          data: {
            groupId: gid,
            sortOrder: seq,
            caption: parsed.hasCaption ? parsed.caption : null,
            imageEtag,
            imageSize,
            audioEtag,
            audioSize,
          },
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'P2002') throw new ConflictError('frame sortOrder already exists');
        throw err;
      }
    } else {
      const data: Record<string, unknown> = {};
      if (parsed.hasCaption) data.caption = parsed.caption;
      if (imageEtag && imageSize !== null) {
        data.imageEtag = imageEtag;
        data.imageSize = imageSize;
      }
      if (audioEtag && audioSize !== null) {
        data.audioEtag = audioEtag;
        data.audioSize = audioSize;
      }
      if (Object.keys(data).length > 0) {
        await this.prisma.frame.update({
          where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
          data,
        });
      }
    }

    if (imageBytes) await this.blob.write(gid, seq, 'image', imageBytes);
    if (audioBytes) await this.blob.write(gid, seq, 'audio', audioBytes);

    const group_etag = await this.groups.recomputeGroupEtag(gid);

    let finalImageEtag = imageEtag;
    let finalAudioEtag = audioEtag;
    if (!finalImageEtag || !finalAudioEtag) {
      const cur = await this.prisma.frame.findUnique({
        where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
        select: { imageEtag: true, audioEtag: true },
      });
      if (cur) {
        finalImageEtag ??= cur.imageEtag;
        finalAudioEtag = cur.audioEtag;
      }
    }
    return {
      sort_order: seq,
      image_etag: finalImageEtag ?? '',
      audio_etag: finalAudioEtag,
      group_etag,
    };
  }

  private async requireFrame(gid: string, seq: number): Promise<void> {
    const f = await this.prisma.frame.findUnique({
      where: { groupId_sortOrder: { groupId: gid, sortOrder: seq } },
      select: { sortOrder: true },
    });
    if (!f) throw new NotFoundError('frame not found');
  }
}
