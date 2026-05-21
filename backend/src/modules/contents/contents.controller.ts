import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  CreateDynamicContentRequest,
  GenerateContentTtsRequest,
  PatchDynamicContentRequest,
  PreviewDynamicContentRequest,
  DynamicConfig,
  type ContentDetailT,
  type ContentMutationResponseT,
  type ManifestResponseT,
} from 'shared';
import { CurrentUser, type WebUserContext } from '../../common/decorators/current-user.decorator';
import {
  CurrentDevice,
  type DeviceContext,
} from '../../common/decorators/current-device.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtOrDeviceAuthGuard } from '../../common/guards/jwt-or-device-auth.guard';
import { etagMatches, respondWithEtag } from '../../common/etag/etag.util';
import { ContentsService } from './contents.service';
import { MultipartParser } from './multipart.parser';
import { ReorderContentsDto } from './dto/reorder-contents.dto';
import { PatchContentDto } from './dto/patch-content.dto';

@Controller()
export class ContentsController {
  constructor(
    private readonly contents: ContentsService,
    private readonly multipart: MultipartParser
  ) {}

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('groups/:groupId/manifest')
  async manifest(
    @Param('groupId') groupId: string,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const m = await this.contents.manifest(groupId, {
      userId: user?.userId,
      deviceId: device?.deviceId,
    });
    const ifNoneMatch = req.headers['if-none-match'];
    const headerEtag = `"${m.manifestEtag}"`;
    if (typeof ifNoneMatch === 'string' && etagMatches(ifNoneMatch, m.manifestEtag)) {
      void reply
        .status(304)
        .header('ETag', headerEtag)
        .header('Cache-Control', 'private, must-revalidate')
        .send();
      return;
    }
    const body: ManifestResponseT = {
      group: m.group,
      contents: m.contents,
    };
    void reply
      .header('ETag', headerEtag)
      .header('Cache-Control', 'private, must-revalidate')
      .header('Content-Type', 'application/json; charset=utf-8')
      .send(body);
  }

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('groups/:groupId/contents')
  list(
    @Param('groupId') groupId: string,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined
  ): Promise<ContentDetailT[]> {
    return this.contents.list(groupId, {
      userId: user?.userId,
      deviceId: device?.deviceId,
    });
  }

  @Post('groups/:groupId/contents')
  @HttpCode(201)
  async create(
    @Param('groupId') groupId: string,
    @CurrentUser() user: WebUserContext,
    @Headers('content-type') ct: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest
  ): Promise<ContentMutationResponseT> {
    if (ct?.startsWith('multipart/form-data')) {
      const parsed = await this.multipart.parseContentUpload(req);
      return this.contents.appendImage(groupId, user.userId, parsed);
    }
    if (!ct?.startsWith('application/json')) {
      throw new BadRequestException('仅支持 multipart/form-data 或 application/json');
    }
    const parsed = CreateDynamicContentRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? '配置非法');
    }
    return this.contents.appendDynamic(groupId, user.userId, parsed.data);
  }

  @Put('groups/:groupId/contents/order')
  reorder(
    @Param('groupId') groupId: string,
    @CurrentUser() user: WebUserContext,
    @Body() body: ReorderContentsDto
  ): Promise<{ manifest_etag: string }> {
    return this.contents.reorder(groupId, user.userId, body.order);
  }

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('contents/:contentId')
  getOne(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined
  ): Promise<ContentDetailT> {
    return this.contents.get(contentId, {
      userId: user?.userId,
      deviceId: device?.deviceId,
    });
  }

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('contents/:contentId/image')
  async image(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const r = await this.contents.readImage(contentId, {
      userId: user?.userId,
      deviceId: device?.deviceId,
    });
    respondWithEtag(req, reply, r.etag, r.data, 'application/octet-stream');
  }

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('contents/:contentId/audio')
  async audio(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const r = await this.contents.readAudio(contentId, {
      userId: user?.userId,
      deviceId: device?.deviceId,
    });
    respondWithEtag(req, reply, r.etag, r.data, 'application/octet-stream');
  }

  @Patch('contents/:contentId')
  async patch(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext,
    @Headers('content-type') ct: string,
    @Req() req: FastifyRequest
  ): Promise<ContentMutationResponseT> {
    if (ct?.startsWith('multipart/form-data')) {
      const parsed = await this.multipart.parseContentUpload(req);
      return this.contents.patchImage(contentId, user.userId, parsed);
    }
    const body = (req.body ?? null) as unknown;
    const objectBody =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    if (objectBody?.config !== undefined) {
      const dynamicParsed = PatchDynamicContentRequest.safeParse(body);
      if (!dynamicParsed.success) {
        throw new BadRequestException(dynamicParsed.error.issues[0]?.message ?? '配置非法');
      }
      return this.contents.patchDynamic(contentId, user.userId, {
        config: dynamicParsed.data.config,
        frame_name: dynamicParsed.data.frame_name,
      });
    }
    const parsed = PatchContentDto.schema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? '参数非法');
    }
    return this.contents.patchFrameName(contentId, user.userId, parsed.data.frame_name);
  }

  @Delete('contents/:contentId')
  @HttpCode(204)
  async delete(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext
  ): Promise<void> {
    await this.contents.delete(contentId, user.userId);
  }

  @Delete('contents/:contentId/audio')
  deleteAudio(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext
  ): Promise<{ manifest_etag: string }> {
    return this.contents.deleteAudio(contentId, user.userId);
  }

  @Post('contents/:contentId/audio/tts')
  generateTtsAudio(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext,
    @Body() body: unknown
  ): Promise<ContentMutationResponseT> {
    const parsed = GenerateContentTtsRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? '参数非法');
    }
    return this.contents.generateImageTts(contentId, user.userId, parsed.data);
  }

  @Post('contents/preview')
  async previewDynamicDirect(@Body() body: unknown, @Res() reply: FastifyReply): Promise<void> {
    const parsed = PreviewDynamicContentRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? '配置非法');
    }
    const data = await this.contents.previewDynamicDirect(parsed.data);
    void reply.header('Cache-Control', 'no-store').type('application/octet-stream').send(data);
  }

  @Post('contents/:contentId/preview')
  async previewDynamic(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const body = (req.body ?? {}) as { config?: unknown; frame_name?: unknown };
    const configParsed = DynamicConfig.safeParse(body.config);
    if (!configParsed.success) {
      throw new BadRequestException(configParsed.error.issues[0]?.message ?? '配置非法');
    }
    const frameName =
      typeof body.frame_name === 'string' || body.frame_name === null ? body.frame_name : undefined;
    const data = await this.contents.previewDynamic(contentId, user.userId, {
      config: configParsed.data,
      frame_name: frameName,
    });
    void reply.header('Cache-Control', 'no-store').type('application/octet-stream').send(data);
  }
}
