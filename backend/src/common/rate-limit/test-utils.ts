import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit-guard';

export function createRateLimitGuard(options: unknown): RateLimitGuard {
  return new RateLimitGuard({
    getAllAndOverride: () => options,
  } as unknown as Reflector);
}
