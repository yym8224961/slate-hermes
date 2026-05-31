import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthError } from '../../errors';
import {
  CURRENT_DEVICE_KEY,
  CURRENT_USER_KEY,
  type DeviceContext,
  type WebUserContext,
} from '../auth-context';
import { JwtTokenService } from '../../../infra/auth/jwt-token.service';
import { DeviceSecretAuthCacheService } from '../../../infra/auth/device-secret-auth-cache.service';
import { extractDeviceSecret, extractWebToken } from './http-token';

@Injectable()
export class JwtOrDeviceAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: JwtTokenService,
    private readonly deviceSecrets: DeviceSecretAuthCacheService
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<
      FastifyRequest & {
        [CURRENT_USER_KEY]?: WebUserContext;
        [CURRENT_DEVICE_KEY]?: DeviceContext;
      }
    >();

    if (this.tryJwt(req)) return true;
    if (await this.tryDevice(req)) return true;
    throw new AuthError('未登录或登录已过期');
  }

  private tryJwt(req: FastifyRequest & { [CURRENT_USER_KEY]?: WebUserContext }): boolean {
    const user = this.tokens.tryVerifyUser(extractWebToken(req));
    if (!user) return false;
    req[CURRENT_USER_KEY] = user;
    return true;
  }

  private async tryDevice(
    req: FastifyRequest & { [CURRENT_DEVICE_KEY]?: DeviceContext }
  ): Promise<boolean> {
    const secret = extractDeviceSecret(req);
    if (!secret) return false;
    const d = await this.deviceSecrets.authenticate(secret);
    if (!d) return false;
    req[CURRENT_DEVICE_KEY] = d;
    return true;
  }
}
