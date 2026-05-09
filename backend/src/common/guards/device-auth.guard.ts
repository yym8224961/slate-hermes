import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { DEVICE_MAC_HEADER } from 'shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuthError } from '../errors';
import { CURRENT_DEVICE_KEY, type DeviceContext } from '../decorators/current-device.decorator';

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<
      FastifyRequest & {
        [CURRENT_DEVICE_KEY]?: DeviceContext;
      }
    >();
    const mac = readMac(req);
    if (!mac) throw new AuthError(`missing or malformed ${DEVICE_MAC_HEADER}`);

    const device = await this.prisma.device.findUnique({
      where: { mac },
      select: { id: true, mac: true },
    });
    if (!device) {
      throw new AuthError('device not registered, POST /api/v1/devices first');
    }
    req[CURRENT_DEVICE_KEY] = { deviceId: device.id, mac: device.mac };
    return true;
  }
}

export function readMac(req: FastifyRequest): string | null {
  const raw = req.headers[DEVICE_MAC_HEADER.toLowerCase()];
  if (!raw || Array.isArray(raw)) return null;
  const mac = raw.replace(/-/g, ':').toUpperCase();
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return null;
  return mac;
}
