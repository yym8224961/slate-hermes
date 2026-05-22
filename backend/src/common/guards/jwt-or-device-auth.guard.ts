import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuthError } from '../errors';
import { CURRENT_USER_KEY, type WebUserContext } from '../decorators/current-user.decorator';
import { CURRENT_DEVICE_KEY, type DeviceContext } from '../decorators/current-device.decorator';
import { readDeviceSecret } from './device-auth.guard';
import { JwtTokenService } from '../../modules/auth/jwt-token.service';
import { extractWebToken } from '../auth/http-token';

@Injectable()
export class JwtOrDeviceAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: JwtTokenService,
    private readonly prisma: PrismaService
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
    const secret = readDeviceSecret(req);
    if (!secret) return false;
    const hash = createHash('sha256').update(secret).digest('hex');
    const d = await this.prisma.device.findUnique({
      where: { secretHash: hash },
      select: { id: true, mac: true },
    });
    if (!d) return false;
    req[CURRENT_DEVICE_KEY] = { deviceId: d.id, mac: d.mac };
    return true;
  }
}
