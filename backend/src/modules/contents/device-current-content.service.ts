import { Injectable, Logger } from '@nestjs/common';
import type { ContentKind } from '@prisma/client';
import type { ContentSummaryT } from 'shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { formatError } from '../../common/utils/error-format';
import { DynamicContentRendererService } from '../dynamic-content/dynamic-content-renderer.service';
import type { DevicePollSnapshot } from '../devices/device-types';
import { contentToSummary } from './content-presenter';
import { CONTENT_SELECT, type ContentSelectRow } from './content-select';

export interface CurrentContentRequest {
  deviceId: string;
  groupId: string;
  seq: number;
  contentId: string;
  manifestEtag: string;
  content: ContentSelectRow;
}

@Injectable()
export class DeviceCurrentContentService {
  private readonly logger = new Logger(DeviceCurrentContentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dynamicRenderer: DynamicContentRendererService
  ) {}

  async resolveCurrentContentRequest(
    deviceOrId: string,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined
  ): Promise<CurrentContentRequest | null>;
  async resolveCurrentContentRequest(
    deviceOrId: DevicePollSnapshot,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined
  ): Promise<CurrentContentRequest | null>;
  async resolveCurrentContentRequest(
    deviceOrId: string | DevicePollSnapshot,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined
  ): Promise<CurrentContentRequest | null> {
    const seq = telemetry?.current_content_seq;
    if (seq === undefined || !Number.isInteger(seq) || seq < 0) return null;
    const device =
      typeof deviceOrId === 'string'
        ? await this.prisma.device.findUnique({
            where: { id: deviceOrId },
            select: {
              id: true,
              selectedGroupId: true,
              selectedGroup: { select: { manifestEtag: true } },
            },
          })
        : deviceOrId;
    const groupId = device?.selectedGroupId;
    if (!groupId) return null;
    if (telemetry?.current_group && telemetry.current_group !== groupId) return null;
    if (!telemetry?.manifest_etag || telemetry.manifest_etag !== device.selectedGroup?.manifestEtag)
      return null;
    const content = await this.prisma.content.findUnique({
      where: { groupId_sortOrder: { groupId, sortOrder: seq } },
      select: CONTENT_SELECT,
    });
    if (!content) return null;
    return {
      deviceId: device.id,
      groupId,
      seq,
      contentId: content.id,
      manifestEtag: telemetry.manifest_etag,
      content,
    };
  }

  currentContentForDevice(request: CurrentContentRequest): ContentSummaryT | null {
    const content = request.content;
    if (!content || content.groupId !== request.groupId || content.sortOrder !== request.seq) {
      return null;
    }
    return contentToSummary(content);
  }

  async refreshCurrentContentForDeviceIfDue(
    request: CurrentContentRequest | null,
    deviceSnapshot?: DevicePollSnapshot
  ): Promise<CurrentContentRequest | null> {
    if (!request) return null;
    const device =
      deviceSnapshot ??
      (await this.prisma.device.findUnique({
        where: { id: request.deviceId },
        select: { selectedGroupId: true, selectedGroup: { select: { manifestEtag: true } } },
      }));
    if (
      !device ||
      device.selectedGroupId !== request.groupId ||
      device.selectedGroup?.manifestEtag !== request.manifestEtag
    ) {
      return null;
    }
    const content = request.content;
    if (!content || content.groupId !== request.groupId || content.sortOrder !== request.seq) {
      return null;
    }
    if (isCurrentDynamicDue(content)) {
      try {
        const rendered = await this.dynamicRenderer.renderDynamicContent(content.id);
        const updatedContent = await this.prisma.content.findUnique({
          where: { id: request.contentId },
          select: CONTENT_SELECT,
        });
        if (
          !updatedContent ||
          updatedContent.groupId !== request.groupId ||
          updatedContent.sortOrder !== request.seq
        ) {
          return null;
        }
        return { ...request, manifestEtag: rendered.groupEtag, content: updatedContent };
      } catch (err) {
        this.logger.warn(
          `dynamic current-frame refresh failed content=${content.id}: ${formatError(err)}`
        );
      }
    }
    return request;
  }
}

function isCurrentDynamicDue(content: {
  kind: ContentKind;
  dynamicType: string | null;
  dynamicNextRunAt?: Date | null;
  dynamicRefreshDueAt?: Date | null;
}): boolean {
  if (content.kind !== 'dynamic' || !content.dynamicType) return false;
  const dueAt = content.dynamicRefreshDueAt ?? content.dynamicNextRunAt ?? null;
  return dueAt !== null && dueAt.getTime() <= Date.now();
}
