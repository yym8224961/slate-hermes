import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DynamicContentRegistry } from './dynamic-content-registry';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';

export interface CurrentFrameTelemetry {
  current_group?: string | null;
  current_content_seq?: number;
}

type RefreshableContent = {
  id: string;
  groupId: string;
  sortOrder: number;
  kind: string;
  dynamicType: string | null;
  dynamicConfig: Prisma.JsonValue | null;
  dynamicData: Prisma.JsonValue | null;
  dynamicLastRunAt: Date | null;
  dynamicNextRunAt: Date | null;
};

@Injectable()
export class DynamicContentRefreshService {
  private readonly logger = new Logger(DynamicContentRefreshService.name);
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: DynamicContentRegistry,
    private readonly renderer: DynamicContentRendererService
  ) {}

  async refreshDeviceCurrentFrame(
    deviceId: string,
    telemetry: CurrentFrameTelemetry | undefined
  ): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { selectedGroupId: true },
    });
    const groupId = device?.selectedGroupId;
    if (!groupId) return;
    if (telemetry?.current_group && telemetry.current_group !== groupId) return;

    const seq = telemetry?.current_content_seq ?? 0;
    if (!Number.isInteger(seq) || seq < 0) return;

    const content = await this.prisma.content.findUnique({
      where: { groupId_sortOrder: { groupId, sortOrder: seq } },
      select: {
        id: true,
        groupId: true,
        sortOrder: true,
        kind: true,
        dynamicType: true,
        dynamicConfig: true,
        dynamicData: true,
        dynamicLastRunAt: true,
        dynamicNextRunAt: true,
      },
    });
    if (!content) return;
    await this.refreshContentIfDue(content);
  }

  async refreshContentIfDue(content: RefreshableContent): Promise<void> {
    if (content.kind !== 'dynamic' || !content.dynamicType) return;
    if (!this.isDue(content, new Date())) return;

    const existing = this.inflight.get(content.id);
    if (existing) return existing;

    const task = this.renderer
      .renderDynamicContent(content.id)
      .then((result) => {
        this.logger.log(
          `refreshed dynamic content=${content.id} type=${content.dynamicType} seq=${content.sortOrder}` +
            (result.unchanged ? ' unchanged=1' : ' changed=1')
        );
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `refresh dynamic content=${content.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => this.inflight.delete(content.id));
    this.inflight.set(content.id, task);
    return task;
  }

  private isDue(content: RefreshableContent, now: Date): boolean {
    if (content.dynamicNextRunAt) {
      return content.dynamicNextRunAt.getTime() <= now.getTime();
    }
    const ttl = this.registry.defaultTtlSec(content.dynamicType ?? '');
    if (ttl === null) return false;
    if (!content.dynamicLastRunAt) return true;
    return now.getTime() - content.dynamicLastRunAt.getTime() >= ttl * 1000;
  }
}
