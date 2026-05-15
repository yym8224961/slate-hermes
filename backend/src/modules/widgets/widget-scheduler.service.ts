import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';

const BATCH_LIMIT = 50;
const LEASE_MS = 5 * 60 * 1000;

/**
 * 周期扫描到期动态内容并触发重渲染。
 *
 * - 每分钟 :00 跑一次（@nestjs/schedule 的 cron）。
 * - 查询：动态内容 + dynamicType 不是 dashboard + dynamicNextRunAt 已过 → 批 50
 * - dashboard 走纯 push（dynamicNextRunAt 永远 null）
 * - 单项失败不影响整批；renderer 内部已处理错误标记。
 * - 渲染前用 dynamicNextRunAt 做短租约 claim，避免多后端实例重复渲染同一内容。
 */
@Injectable()
export class WidgetSchedulerService {
  private readonly logger = new Logger(WidgetSchedulerService.name);
  /** 仅防单进程内 tick 重入；跨实例互斥由 claimDueContent 的 DB lease 保证。 */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: DynamicContentRendererService
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('上一轮 tick 还在跑，跳过本次');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const now = new Date();
      const due = await this.prisma.content.findMany({
        where: {
          kind: 'dynamic',
          dynamicType: { not: 'dashboard' },
          dynamicNextRunAt: { lte: now },
        },
        orderBy: { dynamicNextRunAt: 'asc' },
        take: BATCH_LIMIT,
        select: { id: true, dynamicType: true },
      });
      if (due.length === 0) return;
      this.logger.log(`tick: ${due.length} 项动态内容到期`);
      // 并发执行 batch：renderer 自带 contentId 维度 Mutex 防同内容重入，
      // 不同 contentId 之间并发安全。Promise.allSettled 让单内容失败不影响其他。
      // sharp/fetch 并发上限交给系统调度；如果动态内容数量极大需要再限并发可加 p-limit。
      const results = await Promise.allSettled(
        due.map(async (f) => {
          const claimed = await this.claimDueContent(f.id, now);
          if (!claimed) return { skipped: true };
          await this.renderer.renderDynamicContent(f.id);
          return { skipped: false };
        })
      );
      let ok = 0;
      let failed = 0;
      let skipped = 0;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          if (r.value.skipped) skipped++;
          else ok++;
        } else {
          failed++;
          const f = due[i]!;
          this.logger.warn(
            `renderDynamicContent failed contentId=${f.id} type=${f.dynamicType}: ${
              r.reason instanceof Error ? r.reason.message : String(r.reason)
            }`
          );
        }
      });
      this.logger.log(
        `tick: 完成 ok=${ok} skipped=${skipped} failed=${failed} elapsedMs=${Date.now() - startedAt}`
      );
    } catch (e) {
      this.logger.error('tick 整批失败', e);
    } finally {
      this.running = false;
    }
  }

  private async claimDueContent(contentId: string, dueBefore: Date): Promise<boolean> {
    const leaseUntil = new Date(Date.now() + LEASE_MS);
    const result = await this.prisma.content.updateMany({
      where: {
        id: contentId,
        kind: 'dynamic',
        dynamicType: { not: 'dashboard' },
        dynamicNextRunAt: { lte: dueBefore },
      },
      data: { dynamicNextRunAt: leaseUntil },
    });
    return result.count === 1;
  }
}
