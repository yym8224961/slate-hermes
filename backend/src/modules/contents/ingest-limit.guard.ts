import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RateLimitedError } from '../../common/errors';
import { FixedWindowRateLimiter } from '../../common/rate-limit/fixed-window-rate-limiter';

/**
 * Ingest 端点的简易限流 + body 大小检查。
 *
 * 为什么不用 @fastify/rate-limit:NestJS + Fastify 适配层不暴露 route-level
 * Fastify config，全局 rate-limit 配 `global: false` 后无法只对特定 route 启用。
 * 这里手写一份足够保护 ingest 这一个端点。
 *
 * 限制：
 *   - 30 req/min/contentId（固定窗口；每 60s 重置一次计数）
 *   - Content-Length > 64KB → 413；chunked 请求在 controller 解析后再按实际 JSON 大小复检。
 */
@Injectable()
export class IngestLimitGuard implements CanActivate {
  private static readonly WINDOW_MS = 60_000;
  private static readonly MAX_PER_WINDOW = 30;
  private static readonly MAX_BODY_BYTES = 64 * 1024;
  /** 防止攻击者用随机 contentId 把 Map 打爆内存 */
  private static readonly MAX_BUCKETS = 10_000;
  private static readonly STALE_BUCKET_MS = IngestLimitGuard.WINDOW_MS * 2;

  private readonly limiter = new FixedWindowRateLimiter({
    windowMs: IngestLimitGuard.WINDOW_MS,
    maxBuckets: IngestLimitGuard.MAX_BUCKETS,
    staleBucketMs: IngestLimitGuard.STALE_BUCKET_MS,
  });

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
        throw tooLarge();
      }
    }

    // 2. 速率限制（按 contentId 维度，capability URL 模型下没有更细粒度的身份）
    const hit = this.limiter.hit(contentId, IngestLimitGuard.MAX_PER_WINDOW);
    if (!hit.allowed) {
      throw new RateLimitedError(`每分钟最多 ${IngestLimitGuard.MAX_PER_WINDOW} 次推送`, {
        retry_after_sec: hit.retryAfterSec,
      });
    }

    return true;
  }

  static assertPayloadSize(body: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(body ?? null), 'utf8');
    if (bytes > IngestLimitGuard.MAX_BODY_BYTES) {
      throw tooLarge();
    }
  }
}

function tooLarge(): HttpException {
  return new HttpException(
    { error: 'payload_too_large', message: '请求体超过 64KB' },
    HttpStatus.PAYLOAD_TOO_LARGE
  );
}
