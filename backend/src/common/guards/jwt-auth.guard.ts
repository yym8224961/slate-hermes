import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import { AppConfig } from '../../infra/config/app.config';
import { AuthError } from '../errors';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { CURRENT_USER_KEY, WebUserContext } from '../decorators/current-user.decorator';

interface JwtPayload {
  sub: string;
  email: string;
  username: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfig
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

    const token = extractToken(req);
    if (!token) throw new AuthError('missing or invalid token');

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, this.config.jwtSecret) as JwtPayload;
    } catch {
      throw new AuthError('missing or invalid token');
    }
    if (!payload?.sub) throw new AuthError('missing or invalid token');

    req[CURRENT_USER_KEY] = {
      userId: payload.sub,
      email: payload.email,
      username: payload.username ?? '',
    };
    return true;
  }
}

function extractToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
  if (cookies?.auth_token) return cookies.auth_token;

  const raw = req.headers.cookie;
  if (raw) {
    const match = raw.match(/(?:^|;\s*)auth_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}
