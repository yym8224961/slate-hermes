import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Ingest 端点的简易限流 + body 大小检查。
 *
 * 为什么不用 @fastify/rate-limit：NestJS + Fastify 适配层不暴露 route-level
 * Fastify config，全局 rate-limit 配 `global: false` 后无法只对特定 route 启用。
 * 这里手写一份足够保护 ingest 这一个端点。
 *
 * 限制：
 *   - 30 req/min/contentId（固定窗口；每 60s 重置一次计数）
 *   - Content-Length > 64KB → 413
 *
 * 内存模型：Map<contentId, { windowStartMs, currentCount, lastSeenMs }>。
 * 定期清理长期不活跃的 contentId，DoS 防护再用 MAX_BUCKETS 做硬上限。
 */
@Injectable()
export class IngestLimitGuard implements CanActivate {
  private static readonly WINDOW_MS = 60_000;
  private static readonly MAX_PER_WINDOW = 30;
  private static readonly MAX_BODY_BYTES = 64 * 1024;
  /** 防止攻击者用随机 contentId 把 Map 打爆内存 */
  private static readonly MAX_BUCKETS = 10_000;
  private static readonly STALE_BUCKET_MS = IngestLimitGuard.WINDOW_MS * 10;

  private buckets = new Map<
    string,
    { windowStartMs: number; currentCount: number; lastSeenMs: number }
  >();
  private lastCleanupMs = 0;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const contentId = (req.params as { contentId?: string })?.contentId;
    if (!contentId) {
      // 没 contentId 让后续 controller 抛 404；这里直接放行。
      return true;
    }

    // 1. body 大小检查（早期拒绝避免读完整 64KB）
    const lenHeader = req.headers['content-length'];
    if (typeof lenHeader === 'string') {
      const len = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(len) && len > IngestLimitGuard.MAX_BODY_BYTES) {
        throw new HttpException(
          { error: 'payload_too_large', message: '请求体超过 64KB' },
          HttpStatus.PAYLOAD_TOO_LARGE
        );
      }
    }

    // 2. 速率限制
    const now = Date.now();
    this.cleanupStaleBuckets(now);
    let bucket = this.buckets.get(contentId);
    if (!bucket || now - bucket.windowStartMs >= IngestLimitGuard.WINDOW_MS) {
      // 超出上限时淘汰最老一条（Map 按插入顺序迭代）
      if (!bucket && this.buckets.size >= IngestLimitGuard.MAX_BUCKETS) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey) this.buckets.delete(oldestKey);
      }
      bucket = { windowStartMs: now, currentCount: 0, lastSeenMs: now };
      this.buckets.set(contentId, bucket);
    }
    bucket.lastSeenMs = now;
    bucket.currentCount += 1;
    if (bucket.currentCount > IngestLimitGuard.MAX_PER_WINDOW) {
      const retryAfterSec = Math.ceil(
        (IngestLimitGuard.WINDOW_MS - (now - bucket.windowStartMs)) / 1000
      );
      const exception = new HttpException(
        {
          error: 'rate_limited',
          message: `每分钟最多 ${IngestLimitGuard.MAX_PER_WINDOW} 次推送`,
          retry_after_sec: retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
      // 补全 RFC 6585 要求的 Retry-After 响应头
      const res = ctx.switchToHttp().getResponse<{ header: (k: string, v: string) => void }>();
      res.header('Retry-After', String(retryAfterSec));
      throw exception;
    }

    return true;
  }

  private cleanupStaleBuckets(now: number): void {
    if (now - this.lastCleanupMs < IngestLimitGuard.WINDOW_MS) return;
    this.lastCleanupMs = now;
    for (const [contentId, bucket] of this.buckets) {
      if (now - bucket.lastSeenMs >= IngestLimitGuard.STALE_BUCKET_MS) {
        this.buckets.delete(contentId);
      }
    }
  }
}
