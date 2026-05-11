import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FrameMutationResponseT, FrameSummaryT, ManifestResponseT } from 'shared';
import { CurrentUser, type WebUserContext } from '../../common/decorators/current-user.decorator';
import {
  CurrentDevice,
  type DeviceContext,
} from '../../common/decorators/current-device.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtOrDeviceAuthGuard } from '../../common/guards/jwt-or-device-auth.guard';
import { etagMatches, respondWithEtag } from '../../common/etag/etag.util';
import { FramesService } from './frames.service';
import { MultipartParser } from './multipart.parser';
import { PatchFrameDto } from './dto/patch-frame.dto';
import { ReorderFramesDto } from './dto/reorder-frames.dto';
import { RenderFrameDto } from './dto/render-frame.dto';

@Controller('groups/:gid')
export class FramesController {
  constructor(
    private readonly frames: FramesService,
    private readonly multipart: MultipartParser
  ) {}

  // ── manifest + list（dual-auth）─────────────────────────

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('manifest')
  async manifest(
    @Param('gid') gid: string,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const m = await this.frames.manifest(gid, {
      userId: user?.userId,
      deviceId: device?.deviceId,
    });
    const ifNoneMatch = req.headers['if-none-match'];
    const headerEtag = `"${m.etag}"`;
    if (typeof ifNoneMatch === 'string' && etagMatches(ifNoneMatch, m.etag)) {
      void reply
        .status(304)
        .header('ETag', headerEtag)
        .header('Cache-Control', 'private, must-revalidate')
        .send();
      return;
    }
    const body: ManifestResponseT = {
      group_id: m.group_id,
      group_etag: m.group_etag,
      frames: m.frames,
      default_frame_seq: m.default_frame_seq,
    };
    void reply
      .header('ETag', headerEtag)
      .header('Cache-Control', 'private, must-revalidate')
      .header('Content-Type', 'application/json; charset=utf-8')
      .send(body);
  }

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('frames')
  list(
    @Param('gid') gid: string,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined
  ): Promise<FrameSummaryT[]> {
    return this.frames.listFrames(gid, {
      userId: user?.userId,
      deviceId: device?.deviceId,
    });
  }

  // 写端点 + reorder（注意：reorder 必须在 :seq 之前注册）

  @Post('frames')
  @HttpCode(201)
  async create(
    @Param('gid') gid: string,
    @CurrentUser() user: WebUserContext,
    @Req() req: FastifyRequest
  ): Promise<FrameMutationResponseT> {
    const parsed = await this.multipart.parseFrame(req);
    return this.frames.appendFrame(gid, user.userId, parsed);
  }

  @Put('frames/order')
  async reorder(
    @Param('gid') gid: string,
    @CurrentUser() user: WebUserContext,
    @Body() body: ReorderFramesDto
  ): Promise<{ group_etag: string }> {
    return this.frames.reorderFrames(gid, user.userId, body.order);
  }

  // ── 单帧路径（path param 名 :seq）─────────────────────────

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('frames/:seq')
  getOne(
    @Param('gid') gid: string,
    @Param('seq', ParseIntPipe) seq: number,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined
  ): Promise<FrameSummaryT> {
    return this.frames.getFrame(gid, seq, {
      userId: user?.userId,
      deviceId: device?.deviceId,
    });
  }

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('frames/:seq/image')
  async image(
    @Param('gid') gid: string,
    @Param('seq', ParseIntPipe) seq: number,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const r = await this.frames.readFrameImage(gid, seq, {
      userId: user?.userId,
      deviceId: device?.deviceId,
    });
    respondWithEtag(req, reply, r.etag, r.data, 'application/octet-stream');
  }

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('frames/:seq/audio')
  async audio(
    @Param('gid') gid: string,
    @Param('seq', ParseIntPipe) seq: number,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const r = await this.frames.readFrameAudio(gid, seq, {
      userId: user?.userId,
      deviceId: device?.deviceId,
    });
    respondWithEtag(req, reply, r.etag, r.data, 'application/octet-stream');
  }

  @Patch('frames/:seq')
  async patch(
    @Param('gid') gid: string,
    @Param('seq', ParseIntPipe) seq: number,
    @CurrentUser() user: WebUserContext,
    @Headers('content-type') ct: string,
    @Req() req: FastifyRequest
  ): Promise<FrameMutationResponseT> {
    if (ct?.startsWith('multipart/form-data')) {
      const parsed = await this.multipart.parseFrame(req);
      return this.frames.patchFrameMultipart(gid, seq, user.userId, parsed);
    }
    const body = (req.body ?? null) as unknown;
    const parsed = PatchFrameDto.schema.safeParse(body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return this.frames.patchFrameCaption(gid, seq, user.userId, parsed.data.caption);
  }

  @Delete('frames/:seq')
  @HttpCode(204)
  async delete(
    @Param('gid') gid: string,
    @Param('seq', ParseIntPipe) seq: number,
    @CurrentUser() user: WebUserContext
  ): Promise<void> {
    await this.frames.deleteFrame(gid, seq, user.userId);
  }

  @Delete('frames/:seq/audio')
  async deleteAudio(
    @Param('gid') gid: string,
    @Param('seq', ParseIntPipe) seq: number,
    @CurrentUser() user: WebUserContext
  ): Promise<{ group_etag: string }> {
    return this.frames.deleteAudio(gid, seq, user.userId);
  }

  // ── 渲染推送（JWT）──────────────────────────

  @Post('frames/:seq/render')
  @HttpCode(200)
  async render(
    @Param('gid') gid: string,
    @Param('seq', ParseIntPipe) seq: number,
    @Body() body: RenderFrameDto
  ): Promise<FrameMutationResponseT> {
    return this.frames.renderToFrame(gid, seq, body);
  }
}
