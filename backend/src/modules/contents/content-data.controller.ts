import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { IngestPayload, type IngestPayloadT, type IngestResponseT } from 'shared';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser, type WebUserContext } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ValidationError } from '../../common/errors';
import { ContentsService } from './contents.service';
import { IngestLimitGuard } from './ingest-limit.guard';

@Controller('contents')
export class ContentDataController {
  constructor(private readonly contents: ContentsService) {}

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
    const data: IngestPayloadT = parsed.data;
    const r = await this.contents.ingestDashboard(contentId, data);
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
