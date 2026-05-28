import {
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
  type ContentDetailT,
  type ContentMutationResponseT,
  type ManifestResponseT,
} from 'shared';
import { CurrentUser, type WebUserContext } from '../../common/decorators/current-user.decorator';
import {
  CurrentDevice,
  type DeviceContext,
} from '../../common/decorators/current-device.decorator';
import { JsonBody } from '../../common/decorators/json-body.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { JwtOrDeviceAuthGuard } from '../../common/guards/jwt-or-device-auth.guard';
import { etagMatches, respondWithEtag } from '../../common/etag/etag.util';
import { ContentsService } from './contents.service';
import { MultipartParser } from './multipart.parser';
import { ReorderContentsDto } from './dto/reorder-contents.dto';
import { CreateDynamicContentDto } from './dto/create-dynamic-content.dto';
import { GenerateContentTtsDto } from './dto/generate-content-tts.dto';
import { PreviewDynamicContentDto } from './dto/preview-dynamic-content.dto';
import { ValidationError } from '../../common/errors';
import { PatchContentUnionDto } from './dto/patch-content-union.dto';

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
    @JsonBody(CreateDynamicContentDto) body: CreateDynamicContentDto | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<ContentMutationResponseT> {
    if (ct?.startsWith('multipart/form-data')) {
      const signal = abortSignalForReply(reply);
      const parsed = await this.multipart.parseContentUpload(req);
      return this.contents.appendImage(groupId, user.userId, parsed, signal);
    }
    if (!body) {
      throw new ValidationError('仅支持 multipart/form-data 或 application/json');
    }
    return this.contents.appendDynamic(groupId, user.userId, body);
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
    @JsonBody(PatchContentUnionDto) body: PatchContentUnionDto | undefined,
    @Req() req: FastifyRequest
  ): Promise<ContentMutationResponseT> {
    if (ct?.startsWith('multipart/form-data')) {
      const parsed = await this.multipart.parseContentUpload(req);
      return this.contents.patchImage(contentId, user.userId, parsed);
    }
    if (!body) {
      throw new ValidationError('仅支持 multipart/form-data 或 application/json');
    }
    if (body.config !== undefined) {
      return this.contents.patchDynamic(contentId, user.userId, {
        config: body.config,
        frame_name: body.frame_name,
      });
    }
    return this.contents.patchFrameName(contentId, user.userId, body.frame_name);
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
    @Body() body: GenerateContentTtsDto
  ): Promise<ContentMutationResponseT> {
    return this.contents.generateImageTts(contentId, user.userId, body);
  }

  @Post('contents/preview')
  async previewDynamicDirect(
    @Body() body: PreviewDynamicContentDto,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const data = await this.contents.previewDynamicDirect(body);
    void reply.header('Cache-Control', 'no-store').type('application/octet-stream').send(data);
  }

  @Post('contents/:contentId/preview')
  async previewDynamic(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext,
    @Body() body: PreviewDynamicContentDto,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const data = await this.contents.previewDynamic(contentId, user.userId, {
      config: body.config,
      frame_name: body.frame_name,
      data: body.data,
    });
    void reply.header('Cache-Control', 'no-store').type('application/octet-stream').send(data);
  }
}

function abortSignalForReply(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  return controller.signal;
}
