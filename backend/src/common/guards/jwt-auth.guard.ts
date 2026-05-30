import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AuthError } from '../errors';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { CURRENT_USER_KEY, type WebUserContext } from '../decorators/current-user.decorator';
import { JwtTokenService } from '../../infra/auth/jwt-token.service';
import { extractWebToken } from './http-token';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: JwtTokenService
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<
      FastifyRequest & {
        [CURRENT_USER_KEY]?: WebUserContext;
      }
    >();

    const user = this.tokens.tryVerifyUser(extractWebToken(req));
    if (!user) throw new AuthError('未登录或登录已过期');
    req[CURRENT_USER_KEY] = user;
    return true;
  }
}
