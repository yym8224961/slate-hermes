import { Injectable, Logger } from '@nestjs/common';
import type { Content } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { BlobService } from '../../infra/blob/blob.service';
import { computeETag } from '../../common/etag/etag.util';
import { NotFoundError, ValidationError } from '../../common/errors';
import { RenderService } from '../render/render.service';
import { GroupsService } from '../groups/groups.service';
import { WidgetRegistry } from './widget-registry';
import { DynamicFrameRendererService } from '../device-renderer/dynamic-frame-renderer.service';

export interface RenderDynamicContentOptions {
  /** 跳过 etag 比对，强制写盘 + bump etag。用于手动 refresh。 */
  force?: boolean;
  /** dashboard push 时直接用 override 作为 data，不调 provider.fetchData。 */
  dataOverride?: unknown;
  /** 测试可注入。 */
  now?: Date;
}

export interface RenderDynamicContentResult {
  contentId: string;
  imageEtag: string;
  groupEtag: string;
  renderedAt: Date;
  /** 数据未变 → 跳过 blob 写 → 仅 dynamicLastRunAt 更新 */
  unchanged: boolean;
}

/**
 * 动态内容渲染流水线（scheduler + ingest + 手动 refresh 共用入口）。
 *
 * 1. 取 Content 行 + WidgetRegistry.get(dynamicType)
 * 2. dataOverride 优先 → 否则 provider.fetchData()，落 Content.dynamicData
 * 3. DynamicFrameRendererService → LVGL 同源 1bpp 字体直接绘制 400x300 位图
 * 4. 校验 15000 字节
 * 5. computeETag。等于原 imageEtag → 仅 bump dynamicLastRunAt/dynamicNextRunAt（防空翻屏）
 * 6. 否则 BlobService.write + Content.update + GroupsService.recomputeGroupEtag
 * 7. in-process Mutex（按 contentId） 去重 scheduler + push 并发
 */
@Injectable()
export class DynamicContentRendererService {
  private readonly logger = new Logger(DynamicContentRendererService.name);
  private readonly inflight = new Map<string, Promise<RenderDynamicContentResult>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly registry: WidgetRegistry,
    private readonly render: RenderService,
    private readonly dynamicRenderer: DynamicFrameRendererService,
    private readonly groups: GroupsService
  ) {}

  /** 单 contentId 去重：scheduler tick 和 ingest 推送可能并发，让它们串行。 */
  async renderDynamicContent(
    contentId: string,
    opts: RenderDynamicContentOptions = {}
  ): Promise<RenderDynamicContentResult> {
    const existing = this.inflight.get(contentId);
    if (existing) return existing;
    const p = this.doRender(contentId, opts).finally(() => {
      this.inflight.delete(contentId);
    });
    this.inflight.set(contentId, p);
    return p;
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
    if (!entry) {
      throw new ValidationError(`未知动态类型: ${content.dynamicType}`);
    }
    const now = opts.now ?? new Date();

    // —— 1. 取/校验 config ——
    let config: unknown;
    try {
      config = entry.provider.validateConfig(content.dynamicConfig);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.markError(content, `配置非法: ${msg}`, now);
      throw new ValidationError(`动态配置非法: ${msg}`);
    }

    // —— 2. 取数据（dataOverride 优先） ——
    let data: unknown;
    try {
      if (opts.dataOverride !== undefined) {
        data = opts.dataOverride;
      } else {
        data = await entry.provider.fetchData(config, {
          now,
          lastData: content.dynamicData ?? undefined,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `dynamic fetchData 失败 contentId=${contentId} type=${content.dynamicType}: ${msg}`
      );
      // 回退到上次 data；若也没有 → 退化为渲染"数据不可用"占位
      data = content.dynamicData ?? { _error: '数据暂不可用' };
      await this.markError(content, msg, now);
    }

    // —— 3. 拼渲染上下文，直接绘制 1bpp 设备帧 ——
    const renderCtx = {
      type: content.dynamicType,
      title: content.caption,
      config: (config ?? {}) as Record<string, unknown>,
      data: data == null ? null : ((data ?? {}) as Record<string, unknown>),
      renderedAt: now,
    };
    const rendered = await this.renderAndValidate(renderCtx);
    const newImageEtag = computeETag(rendered);

    const nextRunAt = this.computeNextRunAt(content.dynamicType, now);

    // —— 5. etag 未变？仅 bump dynamicLastRunAt/dynamicNextRunAt ——
    if (!opts.force && newImageEtag === content.imageEtag) {
      await this.prisma.content.update({
        where: { id: contentId },
        data: {
          dynamicData: data == null ? undefined : (data as object),
          dynamicLastRunAt: now,
          dynamicNextRunAt: nextRunAt,
          dynamicLastError: null,
        },
      });
      // 即使图没变，group 内其他内容可能并发改了标题 → group_etag 已 bump。
      // 必须读最新值返回；group 不存在（理论不会发生）则抛错而非返回空串误导客户端。
      const groupEtag = await this.currentGroupEtag(content.groupId);
      if (!groupEtag) {
        throw new Error(
          `group ${content.groupId} 不存在（content ${contentId} 的 group 引用悬空）`
        );
      }
      return {
        contentId,
        imageEtag: content.imageEtag,
        groupEtag,
        renderedAt: now,
        unchanged: true,
      };
    }

    // —— 6. 写 blob + 更新 Content + bump group etag ——
    await this.blob.write(content.groupId, content.id, 'image', rendered);
    await this.prisma.content.update({
      where: { id: contentId },
      data: {
        imageEtag: newImageEtag,
        imageSize: rendered.byteLength,
        dynamicData: data == null ? undefined : (data as object),
        dynamicLastRunAt: now,
        dynamicNextRunAt: nextRunAt,
        dynamicLastError: null,
      },
    });
    const groupEtag = await this.groups.recomputeGroupEtag(content.groupId);

    return {
      contentId,
      imageEtag: newImageEtag,
      groupEtag,
      renderedAt: now,
      unchanged: false,
    };
  }

  /** 失败时记错但不打挂调度——继续渲染占位。 */
  private async markError(content: Content, message: string, now: Date): Promise<void> {
    try {
      await this.prisma.content.update({
        where: { id: content.id },
        data: {
          dynamicLastError: message.slice(0, 512),
          dynamicLastRunAt: now,
        },
      });
    } catch (e) {
      this.logger.error(`markError 二次失败 contentId=${content.id}`, e);
    }
  }

  /** TTL → 下次跑的绝对时刻。push-only widget 返回 null。 */
  private computeNextRunAt(dynamicType: string, now: Date): Date | null {
    const ttl = this.registry.defaultTtlSec(dynamicType);
    if (ttl === null) return null;
    return new Date(now.getTime() + ttl * 1000);
  }

  private async currentGroupEtag(gid: string): Promise<string | null> {
    const g = await this.prisma.group.findUnique({ where: { id: gid }, select: { etag: true } });
    return g?.etag ?? null;
  }

  /**
   * 创建模式预览：无 contentId，直接按 dynamicType + config 渲染，不查 DB。
   * 返回 1bpp 内容缓冲（Buffer，15000 字节）。
   */
  async renderPreviewDirect(
    dynamicType: string,
    configOverride: unknown,
    title?: string | null
  ): Promise<Buffer> {
    const entry = this.registry.get(dynamicType);
    if (!entry) throw new ValidationError(`未知动态类型: ${dynamicType}`);

    const config = entry.provider.validateConfig(configOverride);
    const now = new Date();
    const data = await entry.provider.fetchData(config, {
      now,
      lastData: undefined,
    });

    const renderCtx = {
      type: dynamicType,
      title,
      config: (config ?? {}) as Record<string, unknown>,
      data: data == null ? null : ((data ?? {}) as Record<string, unknown>),
      renderedAt: now,
    };
    return this.renderAndValidate(renderCtx);
  }

  /**
   * 预览渲染：使用传入的 configOverride 渲染动态内容，不写库、不改 etag。
   * 用于编辑器实时预览（config 还没保存，不污染 DB）。
   * 返回 1bpp 帧缓冲（Buffer，15000 字节），调用方直接返回为 binary response。
   */
  async renderPreview(
    contentId: string,
    userId: string,
    configOverride: unknown,
    titleOverride?: string | null
  ): Promise<Buffer> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        caption: true,
        kind: true,
        dynamicType: true,
        dynamicData: true,
        group: { select: { ownerUserId: true } },
      },
    });
    if (!content || content.group.ownerUserId !== userId) throw new NotFoundError('内容不存在');
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

    const renderCtx = {
      type: content.dynamicType,
      title: titleOverride === undefined ? content.caption : titleOverride,
      config: (config ?? {}) as Record<string, unknown>,
      data: data == null ? null : ((data ?? {}) as Record<string, unknown>),
      renderedAt: now,
    };
    return this.renderAndValidate(renderCtx);
  }

  private async renderAndValidate(
    renderCtx: Parameters<DynamicFrameRendererService['render']>[0]
  ): Promise<Buffer> {
    const rendered = await this.dynamicRenderer.render(renderCtx);
    this.render.validateFrameSize(rendered);
    return rendered;
  }
}
