import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { DeviceSecretAuthCacheService } from '../../../infra/auth/device-secret-auth-cache.service';
import { AuthError } from '../../errors';
import { CURRENT_DEVICE_KEY, type DeviceContext } from '../auth-context';
import { extractDeviceSecret } from './http-token';

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly deviceSecrets: DeviceSecretAuthCacheService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { [CURRENT_DEVICE_KEY]?: DeviceContext }>();
    const secret = extractDeviceSecret(req);
    if (!secret) {
      throw new AuthError('设备认证失败');
    }
    const device = await this.deviceSecrets.authenticate(secret);
    if (!device) {
      throw new AuthError('设备认证失败');
    }
    req[CURRENT_DEVICE_KEY] = device;
    return true;
  }
}
