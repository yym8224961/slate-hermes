import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuthError } from '../errors';
import { CURRENT_DEVICE_KEY, type DeviceContext } from '../decorators/current-device.decorator';
import { extractBearerToken } from '../auth/http-token';
import { authenticateDeviceSecret } from '../auth/device-secret-auth-cache';

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { [CURRENT_DEVICE_KEY]?: DeviceContext }>();
    const secret = readDeviceSecret(req);
    if (!secret) {
      throw new AuthError('missing Authorization: Bearer <device_secret>');
    }
    const device = await authenticateDeviceSecret(this.prisma, secret);
    if (!device) {
      throw new AuthError('device secret invalid; clear NVS and POST /api/v1/devices');
    }
    req[CURRENT_DEVICE_KEY] = device;
    return true;
  }
}

// 从 Authorization: Bearer <token> 中提取 device_secret。
// device_secret 必须是 64 字符 hex（registerOrReset 的明文格式），不是 hex 直接 reject ——这条
// 也保证 JwtOrDeviceAuthGuard 里 jwt 和 device 两条路径不会互相误识别（jwt 是三段 base64，
// 含点；hex 不含点）。
export function readDeviceSecret(req: FastifyRequest): string | null {
  const token = extractBearerToken(req);
  if (!token) return null;
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  return token;
}
