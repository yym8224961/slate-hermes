import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { AppConfig } from '../../infra/config/app.config';
import { ForbiddenError } from '../errors';
import { CURRENT_USER_KEY, type WebUserContext } from '../decorators/current-user.decorator';

interface JwtPayload {
  sub: string;
  email: string;
}

@Injectable()
export class JwtOrApiKeyAuthGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<
      FastifyRequest & {
        [CURRENT_USER_KEY]?: WebUserContext;
      }
    >();

    if (this.apiKeyOk(req)) return true;
    if (this.tryJwt(req)) return true;
    throw new ForbiddenError('provide JWT or X-Api-Key');
  }

  private apiKeyOk(req: FastifyRequest): boolean {
    const k = req.headers['x-api-key'];
    return typeof k === 'string' && k === this.config.webhookApiKey;
  }

  private tryJwt(req: FastifyRequest & { [CURRENT_USER_KEY]?: WebUserContext }): boolean {
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) return false;
    const token = auth.slice(7).trim();
    try {
      const payload = jwt.verify(token, this.config.jwtSecret) as JwtPayload;
      if (!payload?.sub) return false;
      req[CURRENT_USER_KEY] = { userId: payload.sub, email: payload.email };
      return true;
    } catch {
      return false;
    }
  }
}
