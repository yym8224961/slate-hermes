import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export interface WebUserContext {
  userId: string;
  email: string;
  username: string;
}

export const CURRENT_USER_KEY = 'currentUser';

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
