import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthError } from '../../common/errors';
import { extractBearerToken } from '../../common/nest/guards/http-token';
import { AppConfig } from '../../infra/config/app.config';

@Injectable()
export class HermesAgentAuthGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.hermesAgentToken;
    if (!expected && !this.config.isProd) return true;

    const provided = extractBearerToken(ctx.switchToHttp().getRequest<FastifyRequest>());
    if (!expected || !provided || !tokensEqual(provided, expected)) {
      throw new AuthError('Hermes Agent 认证失败');
    }
    return true;
  }
}

function tokensEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
