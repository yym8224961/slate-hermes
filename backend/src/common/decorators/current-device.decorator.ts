import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export interface DeviceContext {
  deviceId: string;
  mac: string;
}

export const CURRENT_DEVICE_KEY = 'currentDevice';

export const CurrentDevice = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): DeviceContext | undefined => {
    const req = ctx.switchToHttp().getRequest<
      FastifyRequest & {
        [CURRENT_DEVICE_KEY]?: DeviceContext;
      }
    >();
    return req[CURRENT_DEVICE_KEY];
  }
);
