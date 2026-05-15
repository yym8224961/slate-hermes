import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { IngestPayload, type IngestPayloadT, type IngestResponseT } from 'shared';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser, type WebUserContext } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { NotFoundError, ValidationError } from '../../common/errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DynamicContentRendererService } from '../widgets/dynamic-content-renderer.service';
import { IngestLimitGuard } from './ingest-limit.guard';

/**
 * Dashboard 动态内容的数据推送 / 手动刷新端点。
 *
 *   POST /api/v1/contents/:contentId/data     —— @Public，外部系统推 JSON 数据。
 *   POST /api/v1/contents/:contentId/refresh  —— @JWT owner，调试/手动触发重渲染。
 *
 * 单独放一个 controller 是因为：
 *  - /data 端点鉴权（@Public）与其他单帧 CRUD（@JWT）不一致，分开声明更清晰；
 *  - 未来加 @fastify/rate-limit 的 route 级 config 也方便集中。
 */
@Controller('contents')
export class ContentDataController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: DynamicContentRendererService
  ) {}

  /**
   * 数据推送：contentId(cuid) 本身充当 capability URL，不需要额外 token。
   * 仅 dashboard 动态内容可推；其他类型返 404（不暴露存在性）。
   */
  @Public()
  @UseGuards(IngestLimitGuard)
  @Post(':contentId/data')
  async ingest(
    @Param('contentId') contentId: string,
    @Body() body: unknown
  ): Promise<IngestResponseT> {
    const parsed = IngestPayload.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(`payload 非法: ${parsed.error.message}`);
    }
    const f = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { id: true, kind: true, dynamicType: true },
    });
    if (!f || f.kind !== 'dynamic' || f.dynamicType !== 'dashboard') {
      throw new NotFoundError('dashboard 内容不存在');
    }
    const data: IngestPayloadT = parsed.data;
    const r = await this.renderer.renderDynamicContent(contentId, {
      dataOverride: data,
      force: true,
    });
    return {
      content_id: r.contentId,
      image_etag: r.imageEtag,
      group_etag: r.groupEtag,
      rendered_at: r.renderedAt.toISOString(),
    };
  }

  /**
   * 手动触发重渲染。任何动态内容都能调；图片内容调会 400。
   * Owner 用：UI 上"立刻刷新"按钮、调试用。
   */
  @UseGuards(JwtAuthGuard)
  @Post(':contentId/refresh')
  async refresh(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext
  ): Promise<IngestResponseT> {
    const f = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        kind: true,
        groupId: true,
        group: { select: { ownerUserId: true } },
      },
    });
    if (!f) throw new NotFoundError('内容不存在');
    if (f.kind !== 'dynamic') throw new ValidationError('图片内容不支持手动刷新');
    if (f.group.ownerUserId !== user.userId) throw new NotFoundError('内容不存在');
    const r = await this.renderer.renderDynamicContent(contentId, { force: true });
    return {
      content_id: r.contentId,
      image_etag: r.imageEtag,
      group_etag: r.groupEtag,
      rendered_at: r.renderedAt.toISOString(),
    };
  }
}
