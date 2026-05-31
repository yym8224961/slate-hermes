import { clientIp } from '../../common/http/client-ip';
import { type RateLimitGuardOptions } from '../../common/rate-limit/rate-limit-guard';
import { createRateLimit } from '../../common/rate-limit/rate-limit-options';

const INGEST_MAX_PER_WINDOW = 30;

export const weatherCitySearchRateLimit: RateLimitGuardOptions = createRateLimit(
  {},
  {
    key: (req) => `weather-city:${clientIp(req)}`,
    maxPerWindow: 30,
    message: '城市搜索过于频繁，请稍后重试',
  }
);

export const ingestRateLimit: RateLimitGuardOptions = createRateLimit(
  {},
  {
    key: (req) => (req.params as { contentId?: string })?.contentId ?? '',
    maxPerWindow: INGEST_MAX_PER_WINDOW,
    message: `每分钟最多 ${INGEST_MAX_PER_WINDOW} 次推送`,
  }
);
