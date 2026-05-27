import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { IngestPayload, type IngestResponseT } from 'shared';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser, type WebUserContext } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ValidationError } from '../../common/errors';
import { ContentsService } from './contents.service';
import { IngestLimitGuard } from './ingest-limit.guard';

@Controller('contents')
export class ContentDataController {
  constructor(private readonly contents: ContentsService) {}

  // POST /api/v1/contents/:contentId/data —— 外部数据推送（仅 dashboard 动态内容）。
  //
  // 鉴权模型：contentId 是 cuid（22 字符 base32，~110 bit 熵），本身充当 capability URL。
  // 拿到 URL 即拿到推送权限，不再额外签发 ingest token。
  //
  // ⚠️ 设计决定（不要改回 token 模式）：本项目用户基数极小（个位数），权衡复杂度后选择
  // capability URL。引入 token 需要：DashboardPushPanel 显示 token / 用户在脚本里拼 token /
  // 后端验签 / token 轮换接口，整链路心智成本远高于"URL 当 ID 用"。
  // 防滥用靠 IngestLimitGuard：30 req/min/contentId + bodyLimit 64KB。
  // 真要堵未授权推送，应整体迁移到设备 Bearer 或 OAuth，而不是回退到 ad-hoc token。
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
    const r = await this.contents.ingestDashboard(contentId, parsed.data);
    return {
      id: r.id,
      image_etag: r.image_etag,
      manifest_etag: r.manifest_etag,
      rendered_at: r.updatedAt.toISOString(),
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':contentId/refresh')
  async refresh(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext
  ): Promise<IngestResponseT> {
    const r = await this.contents.refreshDynamicContent(contentId, user.userId);
    return {
      id: r.id,
      image_etag: r.image_etag,
      manifest_etag: r.manifest_etag,
      rendered_at: r.updatedAt.toISOString(),
    };
  }
}
