import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { RateLimitedError } from '../../common/errors';
import { DeviceRegisterRateLimitGuard } from './device-register-rate-limit.guard';

function context(ip = '127.0.0.1'): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ ip, headers: {}, method: 'POST', url: '/api/v1/devices' }),
    }),
  } as unknown as ExecutionContext;
}

describe('DeviceRegisterRateLimitGuard', () => {
  it('rate-limits device registration per client ip', () => {
    const guard = new DeviceRegisterRateLimitGuard();

    for (let i = 0; i < 20; i++) {
      expect(guard.canActivate(context())).toBe(true);
    }

    expect(() => guard.canActivate(context())).toThrow(RateLimitedError);
  });
});
