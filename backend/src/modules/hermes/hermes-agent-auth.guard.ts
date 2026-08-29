import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthError } from '../../common/errors';
import { extractBearerToken } from '../../common/nest/guards/http-token';
import { AppConfig } from '../../infra/config/app.config';
import { HermesTokenStore } from './hermes-token.store';

export const HERMES_AGENT_CONTEXT_KEY = 'hermesAgentContext';
export interface HermesAgentContext {
  tokenRevision: number;
}

@Injectable()
export class HermesAgentAuthGuard implements CanActivate {
  constructor(
    private readonly tokenStore: HermesTokenStore,
    private readonly config: AppConfig
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { [HERMES_AGENT_CONTEXT_KEY]?: HermesAgentContext }>();
    const expected = this.tokenStore.get();
    if (!expected && !this.config.isProd) {
      request[HERMES_AGENT_CONTEXT_KEY] = { tokenRevision: this.tokenStore.revision() };
      return true;
    }

    const provided = extractBearerToken(request);
    if (!expected || !provided || !tokensEqual(provided, expected)) {
      throw new AuthError('Hermes Agent 认证失败');
    }
    request[HERMES_AGENT_CONTEXT_KEY] = { tokenRevision: this.tokenStore.revision() };
    return true;
  }
}

function tokensEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
