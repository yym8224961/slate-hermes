import {
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type ContentMutationResponseT } from 'shared';
import { ValidationError } from '../../common/errors';
import { CurrentUser } from '../../common/nest/decorators/auth-context.decorators';
import type { WebUserContext } from '../../common/nest/auth-context';
import { JsonBody } from '../../common/nest/decorators/json-body.decorator';
import { DynamicContentService } from '../dynamic-content/dynamic-content.service';
import { CreateDynamicContentDto } from '../dynamic-content/dto/create-dynamic-content.dto';
import { abortSignalForReply } from './content-controller-helpers';
import { ContentsService } from './contents.service';
import { GenerateContentTtsDto } from './dto/generate-content-tts.dto';
import { PatchContentUnionDto } from './dto/patch-content-union.dto';
import { ReorderContentsDto } from './dto/reorder-contents.dto';
import { MultipartParser } from './multipart-parser';

@Controller()
export class ContentsMutationController {
  constructor(
    private readonly contents: ContentsService,
    private readonly dynamicContent: DynamicContentService,
    private readonly multipart: MultipartParser
  ) {}

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
    return this.dynamicContent.append(groupId, user.userId, body);
  }

  @Put('groups/:groupId/contents/order')
  reorder(
    @Param('groupId') groupId: string,
    @CurrentUser() user: WebUserContext,
    @Body() body: ReorderContentsDto
  ): Promise<{ manifest_etag: string }> {
    return this.contents.reorder(groupId, user.userId, body.order);
  }

  @Patch('contents/:contentId')
  async patch(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext,
    @Headers('content-type') ct: string,
    @JsonBody(PatchContentUnionDto) body: PatchContentUnionDto | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<ContentMutationResponseT> {
    if (ct?.startsWith('multipart/form-data')) {
      const signal = abortSignalForReply(reply);
      const parsed = await this.multipart.parseContentUpload(req);
      return this.contents.patchImage(contentId, user.userId, parsed, signal);
    }
    if (!body) {
      throw new ValidationError('仅支持 multipart/form-data 或 application/json');
    }
    if (body.config !== undefined) {
      return this.dynamicContent.patch(contentId, user.userId, {
        config: body.config,
        frame_name: body.frame_name,
      });
    }
    if (body.frame_name === undefined) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }
    const dynamicPatch = await this.dynamicContent.patchFrameNameIfDynamic(
      contentId,
      user.userId,
      body.frame_name
    );
    if (dynamicPatch) return dynamicPatch;
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
}
