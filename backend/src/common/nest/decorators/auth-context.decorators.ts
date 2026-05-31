import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  CURRENT_DEVICE_KEY,
  CURRENT_USER_KEY,
  IS_PUBLIC_KEY,
  type DeviceContext,
  type WebUserContext,
} from '../auth-context';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WebUserContext | undefined => {
    const req = ctx.switchToHttp().getRequest<
      FastifyRequest & {
        [CURRENT_USER_KEY]?: WebUserContext;
      }
    >();
    return req[CURRENT_USER_KEY];
  }
);

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

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
