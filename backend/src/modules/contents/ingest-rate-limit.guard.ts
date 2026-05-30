import { Injectable } from '@nestjs/common';
import { RateLimitGuardBase } from '../../common/rate-limit/rate-limit-guard';

const INGEST_WINDOW_MS = 60_000;
const INGEST_MAX_PER_WINDOW = 30;
const INGEST_MAX_BUCKETS = 10_000;
const INGEST_STALE_BUCKET_MS = INGEST_WINDOW_MS * 2;

@Injectable()
export class IngestRateLimitGuard extends RateLimitGuardBase {
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
