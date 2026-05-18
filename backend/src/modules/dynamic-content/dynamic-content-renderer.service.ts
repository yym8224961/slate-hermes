import { Injectable, Logger } from '@nestjs/common';
import type { Content } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { computeETag } from '../../common/etag/etag.util';
import { NotFoundError, ValidationError } from '../../common/errors';
import { GroupsService } from '../groups/groups.service';
import { DynamicFrameRendererService } from '../frame-renderer/dynamic-frame-renderer.service';
import { DynamicContentRegistry } from './dynamic-content-registry';
import { nextLocalMidnight, timezoneFromConfig } from './timezone';

export interface RenderDynamicContentOptions {
  force?: boolean;
  dataOverride?: unknown;
  now?: Date;
}

export interface RenderDynamicContentResult {
  contentId: string;
  imageEtag: string;
  groupEtag: string;
  renderedAt: Date;
  unchanged: boolean;
}

@Injectable()
export class DynamicContentRendererService {
  private readonly logger = new Logger(DynamicContentRendererService.name);
  private readonly inflight = new Map<string, Promise<RenderDynamicContentResult>>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly registry: DynamicContentRegistry,
    private readonly renderer: DynamicFrameRendererService,
    private readonly groups: GroupsService
  ) {}

  renderDynamicContent(
    contentId: string,
    opts: RenderDynamicContentOptions = {}
  ): Promise<RenderDynamicContentResult> {
    const canDedupe = !opts.force && opts.dataOverride === undefined;
    const existing = canDedupe ? this.inflight.get(contentId) : undefined;
    if (existing) return existing;

    const previous = this.tails.get(contentId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => this.doRender(contentId, opts));
    const tail = task.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(contentId, tail);
    void tail.finally(() => {
      if (this.tails.get(contentId) === tail) this.tails.delete(contentId);
    });

    if (canDedupe) {
      this.inflight.set(contentId, task);
      void task
        .finally(() => {
          if (this.inflight.get(contentId) === task) this.inflight.delete(contentId);
        })
        .catch(() => undefined);
    }
    return task;
  }

  async renderPreviewDirect(
    dynamicType: string,
    configOverride: unknown,
    frameName?: string | null
  ): Promise<Buffer> {
    const entry = this.registry.get(dynamicType);
    if (!entry) throw new ValidationError(`未知动态类型: ${dynamicType}`);
    const config = entry.provider.validateConfig(configOverride);
    const now = new Date();
    const data = await entry.provider.fetchData(config, { now, lastData: undefined });
    return this.renderAndValidate({
      type: dynamicType,
      frameName,
      config: (config ?? {}) as Record<string, unknown>,
      data: data == null ? null : ((data ?? {}) as Record<string, unknown>),
      renderedAt: now,
    });
  }

  async renderPreview(
    contentId: string,
    ownerUserId: string,
    configOverride: unknown,
    frameNameOverride?: string | null
  ): Promise<Buffer> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        frameName: true,
        kind: true,
        dynamicType: true,
        dynamicData: true,
        groupId: true,
        group: { select: { ownerUserId: true } },
      },
    });
    if (!content || content.group.ownerUserId !== ownerUserId)
      throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic' || !content.dynamicType) {
      throw new ValidationError('该内容不是动态类型');
    }

    const entry = this.registry.get(content.dynamicType);
    if (!entry) throw new ValidationError(`未知动态类型: ${content.dynamicType}`);
    const config = entry.provider.validateConfig(configOverride);
    const now = new Date();
    const data = await entry.provider.fetchData(config, {
      now,
      lastData: content.dynamicData ?? undefined,
    });
    const frameName = frameNameOverride === undefined ? content.frameName : frameNameOverride;
    return this.renderAndValidate({
      type: content.dynamicType,
      frameName,
      config: (config ?? {}) as Record<string, unknown>,
      data: data == null ? null : ((data ?? {}) as Record<string, unknown>),
      renderedAt: now,
    });
  }

  private async doRender(
    contentId: string,
    opts: RenderDynamicContentOptions
  ): Promise<RenderDynamicContentResult> {
    const content = await this.prisma.content.findUnique({ where: { id: contentId } });
    if (!content) throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic' || !content.dynamicType) {
      throw new ValidationError('该内容不是动态类型');
    }
    const entry = this.registry.get(content.dynamicType);
    if (!entry) throw new ValidationError(`未知动态类型: ${content.dynamicType}`);
    const now = opts.now ?? new Date();

    let config: unknown;
    try {
      config = entry.provider.validateConfig(content.dynamicConfig);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markError(content, `配置非法: ${message}`, now);
      throw new ValidationError(`动态配置非法: ${message}`);
    }

    let data: unknown;
    let fetchErrorMessage: string | null = null;
    try {
      if (opts.dataOverride !== undefined) {
        data = opts.dataOverride;
      } else {
        data = await entry.provider.fetchData(config, {
          now,
          lastData: content.dynamicData ?? undefined,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fetchErrorMessage = message;
      this.logger.warn(
        `dynamic fetchData failed content=${contentId} type=${content.dynamicType}: ${message}`
      );
      data = content.dynamicData ?? { _error: '数据暂不可用' };
      await this.markError(content, message, now);
    }

    const rendered = await this.renderAndValidate({
      type: content.dynamicType,
      frameName: content.frameName,
      config: (config ?? {}) as Record<string, unknown>,
      data: data == null ? null : ((data ?? {}) as Record<string, unknown>),
      renderedAt: now,
    });
    const imageEtag = computeETag(rendered);
    const nextRunAt = this.computeNextRunAt(content.dynamicType, config, now);

    if (!opts.force && imageEtag === content.imageEtag) {
      await this.prisma.content.update({
        where: { id: contentId },
        data: {
          ...(data != null ? { dynamicData: data as Prisma.InputJsonValue } : {}),
          dynamicLastRunAt: now,
          dynamicNextRunAt: nextRunAt,
          dynamicLastError: fetchErrorMessage ? fetchErrorMessage.slice(0, 512) : null,
        },
      });
      const groupEtag = await this.groups.recomputeGroupEtag(content.groupId);
      return {
        contentId,
        imageEtag,
        groupEtag,
        renderedAt: now,
        unchanged: true,
      };
    }

    await this.blob.write(content.groupId, content.id, 'image', rendered);
    await this.prisma.content.update({
      where: { id: contentId },
      data: {
        imageEtag,
        imageSize: rendered.byteLength,
        dynamicData: data == null ? Prisma.JsonNull : (data as Prisma.InputJsonValue),
        dynamicLastRunAt: now,
        dynamicNextRunAt: nextRunAt,
        dynamicLastError: fetchErrorMessage ? fetchErrorMessage.slice(0, 512) : null,
      },
    });
    const groupEtag = await this.groups.recomputeGroupEtag(content.groupId);
    return {
      contentId,
      imageEtag,
      groupEtag,
      renderedAt: now,
      unchanged: false,
    };
  }

  private async renderAndValidate(
    input: Parameters<DynamicFrameRendererService['render']>[0]
  ): Promise<Buffer> {
    const rendered = await this.renderer.render(input);
    if (rendered.byteLength !== 15000) {
      throw new Error(`动态帧大小不匹配: ${rendered.byteLength}`);
    }
    return rendered;
  }

  private async markError(content: Content, message: string, now: Date): Promise<void> {
    try {
      await this.prisma.content.update({
        where: { id: content.id },
        data: {
          dynamicLastError: message.slice(0, 512),
          dynamicLastRunAt: now,
        },
      });
    } catch (err) {
      this.logger.error(`markError failed content=${content.id}`, err);
    }
  }

  private computeNextRunAt(dynamicType: string, config: unknown, now: Date): Date | null {
    if (
      dynamicType === 'daily_calendar' ||
      dynamicType === 'month_calendar' ||
      dynamicType === 'history_today'
    ) {
      return nextLocalMidnight(now, timezoneFromConfig(config));
    }
    const ttl = this.registry.defaultTtlSec(dynamicType);
    if (ttl === null) return null;
    return new Date(now.getTime() + ttl * 1000);
  }
}
