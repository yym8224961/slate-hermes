import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { CURRENT_USER_KEY } from '../../common/decorators/current-user.decorator';
import { RateLimitedError } from '../../common/errors';
import { DeviceClaimRateLimitGuard } from './device-claim-rate-limit.guard';

function context(userId = 'user-1', ip = '127.0.0.1'): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        ip,
        headers: {},
        method: 'POST',
        url: '/api/v1/devices/claims',
        [CURRENT_USER_KEY]: { userId, email: `${userId}@example.com`, username: userId },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('DeviceClaimRateLimitGuard', () => {
  it('rate-limits pair-code claim attempts per client and user', () => {
    const guard = new DeviceClaimRateLimitGuard();

    for (let i = 0; i < 5; i++) {
      expect(guard.canActivate(context())).toBe(true);
    }

    expect(() => guard.canActivate(context())).toThrow(RateLimitedError);
    expect(guard.canActivate(context('user-2'))).toBe(true);
  });
});
