import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { AppConfig } from '../../infra/config/app.config';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuthError } from '../errors';
import { CURRENT_USER_KEY, type WebUserContext } from '../decorators/current-user.decorator';
import { CURRENT_DEVICE_KEY, type DeviceContext } from '../decorators/current-device.decorator';
import { readDeviceSecret } from './device-auth.guard';

interface JwtPayload {
  sub: string;
  email: string;
}

@Injectable()
export class JwtOrDeviceAuthGuard implements CanActivate {
  constructor(
    private readonly config: AppConfig,
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
    throw new AuthError('provide JWT or device secret in Authorization: Bearer');
  }

  private tryJwt(req: FastifyRequest & { [CURRENT_USER_KEY]?: WebUserContext }): boolean {
    const token = extractBearer(req) ?? extractCookieToken(req);
    if (!token) return false;
    try {
      const payload = jwt.verify(token, this.config.jwtSecret) as JwtPayload;
      if (!payload?.sub) return false;
      req[CURRENT_USER_KEY] = { userId: payload.sub, email: payload.email };
      return true;
    } catch {
      return false;
    }
  }

  private async tryDevice(
    req: FastifyRequest & { [CURRENT_DEVICE_KEY]?: DeviceContext }
  ): Promise<boolean> {
    const secret = readDeviceSecret(req);
    if (!secret) return false;
    const hash = createHash('sha256').update(secret).digest('hex');
    const d = await this.prisma.device.findFirst({
      where: { secretHash: hash },
      select: { id: true, mac: true },
    });
    if (!d) return false;
    req[CURRENT_DEVICE_KEY] = { deviceId: d.id, mac: d.mac };
    return true;
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

function extractCookieToken(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const m = raw.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
