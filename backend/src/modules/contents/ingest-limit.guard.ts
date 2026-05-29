import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RateLimitGuardBase } from '../../common/rate-limit/rate-limit-guard';

const INGEST_WINDOW_MS = 60_000;
const INGEST_MAX_PER_WINDOW = 30;
const INGEST_MAX_BODY_BYTES = 64 * 1024;
const INGEST_MAX_BUCKETS = 10_000;
const INGEST_STALE_BUCKET_MS = INGEST_WINDOW_MS * 2;

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
  private readonly rateLimit = new IngestRateLimitGuard();

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
      if (Number.isFinite(len) && len > INGEST_MAX_BODY_BYTES) {
        throw tooLarge();
      }
    }

    // 2. 速率限制（按 contentId 维度，capability URL 模型下没有更细粒度的身份）
    return this.rateLimit.canActivate(ctx);
  }

  static assertPayloadSize(body: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(body ?? null), 'utf8');
    if (bytes > INGEST_MAX_BODY_BYTES) {
      throw tooLarge();
    }
  }
}

class IngestRateLimitGuard extends RateLimitGuardBase {
  constructor() {
    super({
      limiter: {
        windowMs: INGEST_WINDOW_MS,
        maxBuckets: INGEST_MAX_BUCKETS,
        staleBucketMs: INGEST_STALE_BUCKET_MS,
      },
      key: (req) => (req.params as { contentId?: string })?.contentId ?? '',
      maxPerWindow: INGEST_MAX_PER_WINDOW,
      message: `每分钟最多 ${INGEST_MAX_PER_WINDOW} 次推送`,
    });
  }
}

function tooLarge(): HttpException {
  return new HttpException(
    { error: 'payload_too_large', message: '请求体超过 64KB' },
    HttpStatus.PAYLOAD_TOO_LARGE
  );
}
